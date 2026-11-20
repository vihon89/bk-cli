"""Local MotionGit adapter bridge. Only a downloaded native package may provide the visuals."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile


class MotionError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def unpack(archive, root):
    with zipfile.ZipFile(archive) as z:
        infos = z.infolist()
        if len(infos) > 30000 or sum(i.file_size for i in infos) > 2 * 1024**3:
            raise ValueError("包超出解压限制")
        for i in infos:
            parts = PurePosixPath(i.filename).parts
            if (not parts or PureWindowsPath(i.filename).anchor or "\\" in i.filename
                    or any(p == ".." or ":" in p or p.endswith((" ", ".")) or PureWindowsPath(p).is_reserved() for p in parts)
                    or stat.S_ISLNK(i.external_attr >> 16)):
                raise ValueError("模板包内路径无效")
        z.extractall(root)
    manifests = list(root.glob("motion.json")) or list(root.glob("*/motion.json"))
    if len(manifests) != 1:
        raise ValueError("原包须含唯一根 motion.json")
    return manifests[0].parent


def member(root, name):
    p = (root / name).resolve()
    if not p.is_relative_to(root) or not p.is_file():
        raise ValueError("原包声明的文件不存在或越界")
    return p


def load(p):
    return json.loads(p.read_text(encoding="utf-8-sig"))


def bind(value, slots, used):
    if isinstance(value, str) and value in slots:
        used.add(value)
        return slots[value]
    if isinstance(value, dict):
        return {k: bind(v, slots, used) for k, v in value.items()}
    if isinstance(value, list):
        return [bind(v, slots, used) for v in value]
    return value


def probe(file, kind):
    if not file.is_file():
        raise ValueError("找不到本地素材或渲染结果")
    result = subprocess.run(["ffprobe","-v","error","-show_entries","stream=codec_type","-of","json",str(file)], capture_output=True,check=True)
    if kind not in [s.get("codec_type") for s in json.loads(result.stdout)["streams"]]:
        raise ValueError("文件缺少 " + kind + " 轨道")


def kinetic_runtime(root, archive, args, env):
    # A workflow checkout can already contain the adapter environment and locked Node modules.
    workflow = next((p.parent for p in archive.parents if p.name == "vendor"), None)
    if workflow is None and args.get("library_root"):
        workflow = Path(args["library_root"]).parent / "video-workflow"
    if workflow:
        cache = workflow / ".uv-cache-motiongit"
        if cache.is_dir():
            env.setdefault("UV_CACHE_DIR", str(cache))
        required = load(root / "package.json")["dependencies"]["playwright-core"]
        for pkg in (workflow / "vendor").glob("motiontemplates-385712*/**/node_modules/playwright-core/package.json"):
            if load(pkg).get("version") == required:
                env["NODE_PATH"] = os.pathsep.join(filter(None, [str(pkg.parents[1]), env.get("NODE_PATH")]))
                break

    if not (root / "node_modules/playwright-core").is_dir():
        check = subprocess.run(["node", "-e", "require('playwright-core')"], cwd=root, env=env, capture_output=True)
        if check.returncode:
            npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
            if not npm:
                raise MotionError("MOTION_RUNTIME_MISSING", "原模板需要 npm 来安装锁文件中的渲染依赖。")
            subprocess.run([npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=root, env=env,
                           stdout=subprocess.DEVNULL, check=True)
    if os.name == "nt" and not env.get("CHROME"):
        import winreg
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                chrome = winreg.QueryValue(hive, r"Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe").strip('"')
            except OSError:
                continue
            if Path(chrome).is_file():
                env["CHROME"] = chrome
                break
    modules = "import jsonschema,numpy,scipy,soundfile,pyloudnorm,hashlib; assert hasattr(hashlib,'file_digest')"
    check = subprocess.run([sys.executable, "-c", modules], capture_output=True, env=env)
    if check.returncode == 0:
        return [sys.executable], env
    uv = shutil.which("uv")
    if not uv and os.name == "nt" and env.get("LOCALAPPDATA"):
        uv = next((Path(env["LOCALAPPDATA"]) / "Microsoft/WinGet/Packages").glob("astral-sh.uv_*/uv.exe"), None)
    if not uv:
        raise MotionError("MOTION_RUNTIME_MISSING", "请安装 uv，BK 将自动为原模板准备隔离的 Python 依赖。")
    return [str(uv), "run", "--no-project", "--python", "3.13", "--script"], env


def run(a, work):
    rendering = 'output_file' in a
    expected_digest = a.get('package_sha256')
    if rendering and (not a.get('package_file') or not isinstance(expected_digest, str) or not re.fullmatch(r'[a-f0-9]{64}', expected_digest)):
        raise MotionError('MOTION_REVIEW_REQUIRED', '运行适配器前，请审核本地原包并提供其 SHA-256。')
    if a.get("package_file"):
        archive = Path(a["package_file"]).resolve(strict=True)
    else:
        archive = work / "template.motion"
        with urllib.request.urlopen(a["direct"], timeout=60) as response, archive.open("xb") as out:
            while chunk := response.read(1024*1024):
                if out.tell()+len(chunk) > 512*1024**2:
                    raise ValueError("包超出下载限制")
                out.write(chunk)
    checked_archive = archive
    if rendering:
        checked_archive = work / 'reviewed.motion'
        digest = hashlib.sha256()
        with archive.open('rb') as original, checked_archive.open('xb') as verified:
            while chunk := original.read(1024 * 1024):
                if verified.tell() + len(chunk) > 512 * 1024**2:
                    raise ValueError('包超出读取限制')
                digest.update(chunk)
                verified.write(chunk)
        if digest.hexdigest() != expected_digest:
            raise MotionError('MOTION_DIGEST_MISMATCH', '原包与已审核的 SHA-256 不一致。')
    root = unpack(checked_archive, work / "package")
    m = load(root / "motion.json")
    template_id = str(m.get("template", {}).get("id", ""))
    # The catalog repository ID can differ from the package's technical ID.
    known_ids = {a["slug"], str(a["case_id"]), str(a["repository_id"])}
    if str(a["repository_id"]) == "385712":
        known_ids.add("kinetic-tech")
    if template_id not in known_ids:
        raise MotionError("MOTION_ID_MISMATCH","原包模板标识与所选案例不匹配。")
    adapter = member(root, m["runtime"]["entry"])
    schema = load(member(root, m["parameters"]["schema"]))
    contract = {"template": template_id,"profile":m["runtime"]["profile"],"adapter":str(adapter.relative_to(root)),
                "required":schema.get("required",[]),"parameters":list(schema.get("properties",{}))}
    if not rendering:
        return {**contract,"status":"package_ready"}
    dst = Path(a["output_file"])
    if dst.suffix.lower() != ".mp4" or dst.exists():
        raise ValueError("目标须为新的 MP4 文件")
    if adapter.suffix != ".py":
        raise MotionError("MOTION_ADAPTER_UNSUPPORTED","当前入口支持声明 plan/prepare/render 协议的 Python 原包适配器。")
    project = work / "project"
    inputs = project / "inputs"
    inputs.mkdir(parents=True)
    slots = {}
    for field,kind,marker in [("video_file","video","$BK_VIDEO"),("audio_file","audio","$BK_AUDIO")]:
        src = Path(a[field]).resolve(strict=True)
        probe(src, kind)
        dest = inputs / (kind + src.suffix.lower())
        shutil.copyfile(src,dest)
        slots[marker] = dest.relative_to(project).as_posix()
    used = set()
    params = bind(a.get("params",{}),slots,used)
    if used != set(slots):
        return {**contract,"status":"bindings_required","message":"请按原包参数契约提供 params，并分别将 $BK_VIDEO、$BK_AUDIO 放入素材字段。"}
    data = project / "params.json"
    data.write_text(json.dumps(params,ensure_ascii=False),encoding="utf8")
    instance = work / "instance"
    video = work / "render.mp4"
    adapter_variables = {'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE',
                         'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'CHROME',
                         'UV_CACHE_DIR', 'PLAYWRIGHT_BROWSERS_PATH'}
    env = {name: value for name, value in os.environ.items() if name.upper() in adapter_variables}
    command = [sys.executable]
    if template_id == "kinetic-tech" and m["runtime"]["profile"] == "kinetic-user-core/1":
        command, env = kinetic_runtime(root, archive, a, env)
    for stage,args in [("plan",["--input",data,"--out",work/"plan.json"]),("prepare",["--input",data,"--out",instance]),("render",["--instance",instance,"--out",video])]:
        log = work / (stage + ".log")
        with log.open("wb") as stream:
            proc = subprocess.run([*command,adapter,stage,*args],cwd=root,env=env,stdout=stream,stderr=subprocess.STDOUT)
        if proc.returncode:
            raise MotionError("MOTION_ADAPTER_FAILED","原包 "+stage+" 阶段失败。诊断日志："+str(log))
    mixed = video.with_name("render-with-audio.mp4")
    rendered = mixed if mixed.is_file() else video
    probe(rendered,"video")
    probe(rendered,"audio")
    dst.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=dst.parent, delete=False) as stage:
        temp = Path(stage.name)
    try:
        shutil.copyfile(rendered,temp)
        os.link(temp,dst)
    finally:
        temp.unlink(missing_ok=True)
    return {**contract,"status":"rendered","output_file":str(dst)}


def main():
    a = json.load(sys.stdin)
    work = Path(tempfile.mkdtemp(prefix="bk-motion-")).resolve()
    try:
        return run(a,work)
    finally:
        # Preserve only the failing stage log, never an extracted personal package.
        for child in work.iterdir():
            if child.is_file() and child.suffix == ".log" and isinstance(sys.exc_info()[1],MotionError):
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
        if not any(work.iterdir()):
            work.rmdir()


if __name__ == "__main__":
    try:
        result = main()
    except MotionError as e:
        result = {"error": e.code, "message":str(e)}
    except (ValueError,OSError,KeyError,zipfile.BadZipFile,subprocess.SubprocessError) as e:
        result = {"error":"MOTION_INPUT_OR_RUNTIME_ERROR","message":str(e)[:480]}
    print(json.dumps(result,ensure_ascii=True))
