// animepahe.js
const BASE_URL = 'https://animepahe.com';
const SEARCH_API = `${BASE_URL}/api?m=search&q=`;
const RELEASE_API = `${BASE_URL}/api?m=release&id=`;
const LINKS_API = `${BASE_URL}/api?m=links&id=`;

/* ==========================================================================
   MAIN EXTENSION FUNCTIONS
   ========================================================================== */

async function searchResults(keyword) {
    try {
        const query = (keyword || '').trim();
        if (!query) return JSON.stringify([]);

        const response = await soraFetch(`${SEARCH_API}${encodeURIComponent(query)}`, { headers: makeHeaders() });
        if (!response) return JSON.stringify([]);
        
        const json = await response.json();
        if (!json || !json.data || !Array.isArray(json.data)) return JSON.stringify([]);

        const results = json.data.map(item => ({
            title: item.title,
            image: item.poster || 'https://animepahe.com/favicon.ico',
            href: `${BASE_URL}/anime/${item.session}`
        }));

        return JSON.stringify(results);
    } catch (error) {
        console.log('AnimePahe Search error: ' + error);
        return JSON.stringify([]);
    }
}

async function extractDetails(url) {
    try {
        const response = await soraFetch(url, { headers: makeHeaders() });
        if (!response) return JSON.stringify([detailsFallback()]);
        const html = await response.text();

        const description = extractFirst(html, /<meta[^>]*name="description"[^>]*content="([^"]+)"/i)
            || extractFirst(html, /<div class="anime-synopsis">([\s\S]*?)<\/div>/i)
            || 'No description available';

        const airdate = extractFirst(html, /<strong>Status:<\/strong>\s*([^<]+)/i) || 'Unknown';
        const aliases = extractFirst(html, /<strong>Synonyms:<\/strong>\s*([^<]+)/i) || 'No alternative titles';

        return JSON.stringify([{
            description: cleanText(description),
            airdate: cleanText(airdate),
            aliases: cleanText(aliases)
        }]);
    } catch (error) {
        console.log('AnimePahe Details error: ' + error);
        return JSON.stringify([detailsFallback()]);
    }
}

async function extractEpisodes(url) {
    try {
        const response = await soraFetch(url, { headers: makeHeaders() });
        if (!response) return JSON.stringify([]);
        const html = await response.text();

        const sessionMatch = html.match(/\/anime\/([a-f0-9\-]+)/i) || html.match(/let\s+id\s*=\s*["']([a-f0-9\-]+)["']/i);
        const animeSession = sessionMatch ? sessionMatch[1] : null;

        if (!animeSession) return JSON.stringify([]);

        let page = 1;
        let lastPage = 1;
        const episodes = [];

        do {
            const apiResponse = await soraFetch(`${RELEASE_API}${animeSession}&sort=episode_asc&page=${page}`, { headers: makeHeaders() });
            if (!apiResponse) break;
            
            const json = await apiResponse.json();
            if (!json || !json.data) break;

            lastPage = json.last_page || page;

            for (const ep of json.data) {
                episodes.push({
                    href: `${LINKS_API}${animeSession}&session=${ep.session}`,
                    number: parseInt(ep.episode, 10) || 1
                });
            }

            page++;
        } while (page <= lastPage);

        return JSON.stringify(episodes);
    } catch (error) {
        console.log('AnimePahe Episode compilation error: ' + error);
        return JSON.stringify([]);
    }
}

async function extractStreamUrl(apiUrl) {
    const fallback = JSON.stringify({ streams: [], subtitle: '' });
    try {
        const response = await soraFetch(apiUrl, { headers: makeHeaders() });
        if (!response) return fallback;
        
        const json = await response.json();
        if (!json || !json.data || !Array.isArray(json.data)) return fallback;

        const streams = [];

        for (const item of json.data) {
            const qualityKey = Object.keys(item)[0];
            const kwikData = item[qualityKey];
            
            if (kwikData && kwikData.kwik) {
                const kwikEmbedUrl = kwikData.kwik;
                const m3u8Url = await resolveKwikStream(kwikEmbedUrl);
                
                if (m3u8Url) {
                    streams.push({
                        title: `Kwik (${qualityKey}p)`,
                        streamUrl: m3u8Url,
                        headers: {
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                            "Referer": "https://kwik.cx/",
                            "Origin": "https://kwik.cx"
                        }
                    });
                }
            }
        }

        return JSON.stringify({ streams: streams, subtitle: '' });
    } catch (error) {
        console.log('AnimePahe Stream error: ' + error);
        return fallback;
    }
}

/* ==========================================================================
   KWIK STREAM RESOLVER & UTILITIES
   ========================================================================== */

async function resolveKwikStream(embedUrl) {
    try {
        const headers = {
            "Referer": BASE_URL,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        };

        const response = await soraFetch(embedUrl, { headers });
        if (!response) return null;
        const html = await response.text();

        // Check 1: Direct M3U8 inside script
        const directMatch = html.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/i);
        if (directMatch && !directMatch[0].includes('m3u8.png')) {
            return directMatch[0];
        }

        // Check 2: Packed JS unpacking
        const packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?\)\)/);
        if (packedMatch) {
            const paramsMatch = packedMatch[0].match(/}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
            if (paramsMatch) {
                const p = paramsMatch[1];
                const a = parseInt(paramsMatch[2], 10);
                const c = parseInt(paramsMatch[3], 10);
                const k = paramsMatch[4].split('|');

                const unpacked = decodePackedJS(p, a, c, k);
                const m3u8Match = unpacked.match(/https?:\/\/[^"']+\.m3u8[^"']*/);
                if (m3u8Match) return m3u8Match[0];
            }
        }

        // Check 3: Extract form token & submit post back if direct parsing fails
        const actionMatch = html.match(/action=["']([^"']+)["']/i);
        const tokenMatch = html.match(/name=["']_token["']\s+value=["']([^"']+)["']/i);

        if (actionMatch && tokenMatch) {
            const actionUrl = actionMatch[1];
            const token = tokenMatch[1];

            const postResponse = await soraFetch(actionUrl, {
                method: 'POST',
                headers: {
                    ...headers,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': embedUrl
                },
                body: `_token=${encodeURIComponent(token)}`
            });

            if (postResponse) {
                const postHtml = await postResponse.text();
                const postM3u8 = postHtml.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/i);
                if (postM3u8) return postM3u8[0];
            }
        }

        return null;
    } catch (e) {
        console.log('Kwik resolve error: ' + e);
        return null;
    }
}

function decodePackedJS(p, a, c, k) {
    while (c--) {
        if (k[c]) {
            p = p.replace(new RegExp('\\b' + c.toString(a) + '\\b', 'g'), k[c]);
        }
    }
    return p;
}

function makeHeaders() {
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": BASE_URL
    };
}

function extractFirst(html, regex) {
    const match = html.match(regex);
    return match ? match[1].trim() : '';
}

function cleanText(text) {
    return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function detailsFallback() {
    return { description: 'No description available', airdate: 'Unknown', aliases: 'No alternative titles' };
}
