// animepahe.js
const BASE_URL = 'https://animepahe.com';
const SEARCH_API = `${BASE_URL}/api?m=search&l=8&q=`; // Added mandatory page limit parameter
const EPISODE_API = `${BASE_URL}/api?m=release&id=`;

/* ==========================================================================
   MAIN EXTENSION FUNCTIONS
   ========================================================================== */

/**
 * Searches animepahe.com using its public internal JSON endpoint.
 */
async function searchResults(keyword) {
    try {
        const query = (keyword || '').trim();
        if (!query) return JSON.stringify([]);

        const requestUrl = `${SEARCH_API}${encodeURIComponent(query)}`;
        const response = await soraFetch(requestUrl, { headers: makeHeaders() });
        if (!response) return JSON.stringify([]);
        
        const json = await response.json();
        // Fallback checks to prevent empty structural array loops
        if (!json || !json.data || !Array.isArray(json.data)) return JSON.stringify([]);

        const results = json.data.map(item => ({
            title: item.title,
            image: item.poster,
            href: `${BASE_URL}/anime/${item.session}`
        }));

        return JSON.stringify(results);
    } catch (error) {
        console.log('AnimePahe Search error: ' + error);
        return JSON.stringify([]);
    }
}

/**
 * Extracts basic landing-page metadata shell for the selected anime layout.
 */
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

/**
 * Resolves the underlying page to retrieve the Anime ID and fetch all episodes via AnimePahe's paginated layout.
 */
async function extractEpisodes(url) {
    try {
        const response = await soraFetch(url, { headers: makeHeaders() });
        if (!response) return JSON.stringify([]);
        const html = await response.text();

        // Extracts the unique release ID from the page body source
        const ogUrlMatch = html.match(/<meta\s+property=["']og:url["']\s+content=["'][^"']+\/anime\/[^"']+\/(\d+)["']/i)
                        || html.match(/\/anime\/[a-f0-9\-]+\/(\d+)/i);
                        
        let animeId = ogUrlMatch ? ogUrlMatch[1] : null;

        if (!animeId) {
            const scriptMatch = html.match(/id\s*:\s*["']?([a-f0-9\-]+)["']?/i)
                             || html.match(/let\s+id\s*=\s*["']([a-f0-9\-]+)["']/i);
            if (scriptMatch) animeId = scriptMatch[1];
        }

        if (!animeId) return JSON.stringify([]);

        // Fetch paginated episode payload
        const apiResponse = await soraFetch(`${EPISODE_API}${animeId}&sort=episode_asc&page=1`, { headers: makeHeaders() });
        if (!apiResponse) return JSON.stringify([]);
        
        const json = await apiResponse.json();
        const rawEpisodes = (json && json.data && Array.isArray(json.data)) ? json.data : [];
        if (rawEpisodes.length === 0) return JSON.stringify([]);

        const episodes = rawEpisodes.map(ep => ({
            href: `${BASE_URL}/play/${animeId}/${ep.session}`,
            number: parseInt(ep.episode, 10) || 1
        }));

        return JSON.stringify(episodes);
    } catch (error) {
        console.log('AnimePahe Episode compilation error: ' + error);
        return JSON.stringify([]);
    }
}

/**
 * Resolves an individual episode page into streamable HLS links from kwik player frames.
 */
async function extractStreamUrl(url) {
    const fallback = JSON.stringify({ streams: [], subtitle: '' });
    try {
        const response = await soraFetch(url, { headers: makeHeaders() });
        if (!response) return fallback;
        const html = await response.text();

        const kwikMatches = [...html.matchAll(/data-src=["'](https:\/\/kwik\.cx\/e\/[^"']+)["']/g)]
                        || [...html.matchAll(/src=["'](https:\/\/kwik\.cx\/e\/[^"']+)["']/g)];

        if (!kwikMatches || kwikMatches.length === 0) return fallback;

        const streams = [];
        const seenEmbeds = new Set();
        
        for (const match of kwikMatches) {
            const embedUrl = match[1];
            if (seenEmbeds.has(embedUrl)) continue;
            seenEmbeds.add(embedUrl);

            const masterM3u8 = await resolveKwikEmbed(embedUrl);
            if (masterM3u8) {
                const label = embedUrl.includes('1080') ? 'Kwik (1080p)' : 'Kwik (720p)';
                streams.push({
                    title: label,
                    streamUrl: masterM3u8,
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                        "Referer": "https://kwik.cx",
                        "Origin": "https://kwik.cx"
                    }
                });
            }
        }

        return JSON.stringify({ streams: streams, subtitle: '' });
    } catch (error) {
        return fallback;
    }
}

/* ==========================================================================
   INTERNALS & PARSING UTILITIES
   ========================================================================== */

async function resolveKwikEmbed(embedUrl) {
    try {
        const response = await soraFetch(embedUrl, { 
            headers: { "Referer": BASE_URL, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } 
        });
        if (!response) return null;
        const html = await response.text();

        const masterUrlMatch = html.match(/source\s*=\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i)
                            || html.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i)
                            || html.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/i);

        return masterUrlMatch ? masterUrlMatch[1] : null;
    } catch (e) {
        return null;
    }
}

function makeHeaders() {
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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
