// Reads the A+ content section from a public Amazon product page.
// SP-API does not share other brands' A+ content, so this is the only free way to see it.
// Amazon sometimes answers with a "robot check" page; then we report "blocked" and keep the last good copy.

import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { imageId } from './normalize.js';

const SITES = { US: 'www.amazon.com', CA: 'www.amazon.ca', MX: 'www.amazon.com.mx', UK: 'www.amazon.co.uk', DE: 'www.amazon.de' };
const APLUS_SELECTORS = ['#aplusBrandStory_feature_div', '#aplus_feature_div', '#aplus3p_feature_div', '#aplus'];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export function parseAplus(html) {
  if (/validateCaptcha|Robot Check|Type the characters you see|api-services-support@amazon\.com/i.test(html)) {
    return { status: 'blocked' };
  }
  const $ = cheerio.load(html);
  if (!$('#productTitle').length && !$('#dp').length) return { status: 'blocked' };

  const seen = new Set();
  const texts = [];
  const images = [];
  for (const sel of APLUS_SELECTORS) {
    $(sel).each((_, el) => {
      const node = $(el);
      if (seen.has(el) || node.parents().toArray().some((p) => seen.has(p))) return; // skip nested duplicates
      seen.add(el);
      node.find('script, style, noscript').remove();
      node.find('*').append(' '); // keeps words from neighboring blocks apart, e.g. a heading and its paragraph
      texts.push(node.text());
      node.find('img').each((__, img) => {
        const src = $(img).attr('data-src') || $(img).attr('src') || '';
        if (!/\/images\/(I|S)\//.test(src) || /grey-pixel|transparent-pixel/.test(src)) return;
        // Product-style images are stored by their short id; A+ library images keep their full address.
        images.push(src.includes('/images/I/') ? imageId(src) : src.split('?')[0]);
      });
    });
  }
  const text = texts.join(' ').replace(/\s+/g, ' ').trim();
  if (!text && !images.length) return { status: 'none' };

  const uniqueImages = [...new Set(images)];
  const hash = crypto.createHash('sha256').update(text + '|' + uniqueImages.join(',')).digest('hex').slice(0, 16);
  return { status: 'ok', hash, text, images: uniqueImages };
}

export async function fetchAplus(asin, marketplace = 'US') {
  try {
    const res = await fetch(`${process.env.AMAZON_PAGE_BASE || 'https://' + (SITES[marketplace] || SITES.US)}/dp/${asin}?th=1&psc=1`, { headers: HEADERS, redirect: 'follow' });
    if (!res.ok) return { status: 'blocked', note: `HTTP ${res.status}` };
    return parseAplus(await res.text());
  } catch (err) {
    return { status: 'error', note: err.message };
  }
}
