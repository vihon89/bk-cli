export function websiteOrigin(value, { allowHttpLocalhost = false } = {}) {
  let url; try { url = new URL(value); } catch { throw new Error('网站地址必须是可信 HTTPS origin。'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('网站地址不能包含凭据、路径、查询或片段。');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (allowHttpLocalhost && loopback && url.protocol === 'http:' && Number(url.port) >= 1024) return url.origin;
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || loopback || !host.includes('.') || host.includes(':') || /\.(?:local|localhost|internal|lan|test|invalid)$/.test(host)) throw new Error('生产网站必须使用公网 HTTPS 443；本机 HTTP 开发端口需显式启用。');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if ([0, 10, 127].includes(a) || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0)) throw new Error('网站地址不能使用私有或保留 IP。');
  }
  return url.origin;
}

export const isPlaceholderKey = key => !key || ['REPLACE_WITH_YOUR_WEBSITE_KEY_LOCALLY', '在本机填写网站专用Key'].includes(key);
export const isPlaceholderOrigin = origin => !origin || /^https:\/\/your-website\.example\/?$/i.test(origin);
