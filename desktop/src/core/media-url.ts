const DOUYIN_MEDIA_HOST_SUFFIXES = ['douyin.com', 'douyinvod.com', 'douyinpic.com', 'iesdouyin.com'];

export function isAllowedDouyinMediaUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password &&
      (!url.port || url.port === '443') &&
      DOUYIN_MEDIA_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}
