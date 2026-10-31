const fetch = require('node-fetch');

// Vercel serverless function handler
module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET and POST
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get URL parameter
  let targetUrl = req.query.url;

  if (!targetUrl && req.method === 'POST') {
    targetUrl = req.body?.url;
  }

  if (!targetUrl) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  // Validate URL
  try {
    new URL(targetUrl);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Helper functions for packer.js decoding
  function decimalToBaseN(n, base) {
    if (n === 0) return '0';
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    let result = '';
    while (n > 0) {
      result = chars[n % base] + result;
      n = Math.floor(n / base);
    }
    return result;
  }

  function unpackJs(packed, base, count, kList) {
    const repl = [];
    for (let i = 0; i < count; i++) {
      if (kList[i] !== undefined && kList[i] !== '') {
        repl[decimalToBaseN(i, base)] = kList[i];
      }
    }

    let result = packed;
    // Sort by length descending to avoid partial replacements
    const sortedKeys = Object.keys(repl).sort((a, b) => b.length - a.length);

    for (const num of sortedKeys) {
      const val = repl[num];
      const regex = new RegExp(`\\b${num}\\b`, 'g');
      result = result.replace(regex, val);
    }
    return result;
  }

  function extractPacker(code) {
    const pattern = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)\s*\{.*?\}\s*\(\s*'(.+?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'(.+?)'/s;
    const match = code.match(pattern);
    if (match) {
      return {
        encoded: match[1],
        base: parseInt(match[2]),
        count: parseInt(match[3]),
        words: match[4].split('|')
      };
    }
    return null;
  }

  function findM3u8(code) {
    const matches = code.match(/https?:\/\/[^\s"'<>)\]]*\.m3u8[^\s"'<>)\]]*/g) || [];
    return [...new Set(matches)]; // Unique values
  }

  function findUrls(code) {
    const matches = code.match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
    return [...new Set(matches)]; // Unique values
  }

  try {
    // Fetch HTML with proper headers
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://web.topcinemaa.live/',
        'Origin': 'https://web.topcinemaa.live',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0'
      },
      redirect: 'follow',
      timeout: 15000
    });

    const httpCode = response.status;
    if (!response.ok) {
      return res.status(500).json({
        error: 'Failed to fetch page',
        details: `HTTP ${response.status}`,
        http_code: httpCode
      });
    }

    const html = await response.text();

    // Find packed JavaScript
    const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    const packedCodes = [];

    for (const script of scriptMatches) {
      if (script.includes('eval(function')) {
        // Extract content between script tags
        const inner = script.replace(/<\/script>/i, '');
        if (inner.includes('eval(function')) {
          packedCodes.push(inner);
        }
      }
    }

    if (packedCodes.length === 0) {
      return res.status(404).json({ error: 'No eval-packed JavaScript found in page' });
    }

    const allM3u8 = new Set();
    const allUrls = new Set();
    const qualities = [];

    for (const packed of packedCodes) {
      const extracted = extractPacker(packed);
      if (!extracted) continue;

      const decoded = unpackJs(
        extracted.encoded,
        extracted.base,
        extracted.count,
        extracted.words
      );

      const m3u8Urls = findM3u8(decoded);
      const urls = findUrls(decoded);

      for (const url of m3u8Urls) allM3u8.add(url);
      for (const url of urls) allUrls.add(url);
    }

    const m3u8Array = Array.from(allM3u8);
    const urlsArray = Array.from(allUrls);

    if (m3u8Array.length === 0) {
      return res.status(404).json({ error: 'No m3u8 URLs found' });
    }

    // Parse master playlist to get qualities
    const masterUrl = m3u8Array[0];
    let playlist;
    let playlistHttp;

    try {
      const playlistResponse = await fetch(masterUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://vidtube.cam/',
          'Origin': 'https://vidtube.cam',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'video',
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Site': 'cross-site',
          'Cache-Control': 'max-age=0'
        },
        redirect: 'follow',
        timeout: 15000
      });

      playlistHttp = playlistResponse.status;
      if (!playlistResponse.ok) {
        throw new Error(`HTTP ${playlistResponse.status}`);
      }
      playlist = await playlistResponse.text();
    } catch (error) {
      // Just return master URL if playlist parsing fails
      console.error('Playlist fetch failed:', error.message);
      playlist = null;
    }

    if (playlist && playlistHttp === 200) {
      // Parse playlist for qualities
      const pattern = /#EXT-X-STREAM-INF[^#\n]*RESOLUTION=(\d+)x(\d+)[^#\n]*\n([^\n#]+)/g;
      let match;

      while ((match = pattern.exec(playlist)) !== null) {
        const w = parseInt(match[1]);
        const h = parseInt(match[2]);
        const url = match[3].trim();

        let quality;
        if (w >= 1920) quality = "1080p FHD";
        else if (w >= 1280) quality = "720p HD";
        else if (w >= 854) quality = "480p SD";
        else quality = "240p SD";

        qualities.push({
          quality,
          resolution: `${w} x ${h}`,
          url
        });
      }

      // Sort by resolution descending
      qualities.sort((a, b) => {
        const aRes = a.resolution.split('x')[0];
        const bRes = b.resolution.split('x')[0];
        return parseInt(bRes) - parseInt(aRes);
      });
    }

    return res.status(200).json({
      success: true,
      m3u8_urls: m3u8Array,
      qualities: qualities,
      all_urls: urlsArray,
      count: m3u8Array.length
    });

  } catch (error) {
    return res.status(500).json({
      error: 'Failed to fetch page',
      details: error.message,
      http_code: 500
    });
  }
};