// animepahe.js
const BASE_URL = 'https://animepahe.com';
const SEARCH_API = `${BASE_URL}/api?m=search&q=`;
const EPISODE_API = `${BASE_URL}/api?m=release&id=`;

/* ==========================================================================
   MAIN EXTENSION FUNCTIONS (RESTORED VERSION)
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

        const ogUrlMatch = html.match(/<meta\s+property=["']og:url["']\s+content=["'][^"']+\/anime\/[^"']+\/(\d+)["']/i)
                        || html.match(/\/anime\/[a-f0-9\-]+\/(\d+)/i);
                        
        let animeId = ogUrlMatch ? ogUrlMatch[1] : null;

        if (!animeId) {
            const scriptMatch = html.match(/id\s*:\s*["']?([a-f0-9\-]+)["']?/i)
                             || html.match(/let\s+id\s*=\s*["']([a-f0-9\-]+)["']?/i);
            if (scriptMatch) animeId = scriptMatch[1];
        }

        if (!animeId) return JSON.stringify([]);

        const apiResponse = await soraFetch(`${EPISODE_API}${animeId}&sort=episode_asc&page=1`, { headers: makeHeaders() });
        if (!apiResponse) return JSON.stringify([]);
        
        const json = await apiResponse.json();
        const rawEpisodes = (json && json.data && Array.isArray(json.data)) ? json.data : [];
        if (rawEpisodes.length === 0) return JSON.stringify([]);

        const episodes = rawEpisodes.map(ep => ({
            // Forward the specific episode's unique session id for resolving the streams
            href: `${BASE_URL}/api?m=links&id=${ep.id || animeId}&p=kwik`,
            number: parseInt(ep.episode, 10) || 1
        }));

        return JSON.stringify(episodes);
    } catch (error) {
        console.log('AnimePahe Episode compilation error: ' + error);
        return JSON.stringify([]);
    }
}

/**
 * Resolves the stream data directly from AnimePahe's internal streaming links API mapper endpoint.
 */
async function extractStreamUrl(apiUrl) {
    const fallback = JSON.stringify({ streams: [], subtitle: '' });
    try {
        const response = await soraFetch(apiUrl, { headers: makeHeaders() });
        if (!response) return fallback;
        
        const json = await response.json();
        if (!json || !json.data || !Array.isArray(json.data)) return fallback;

        const streams = [];

        // Loop over the video qualities returned directly by AnimePahe's streaming API
        for (const item of json.data) {
            const qualityKey = Object.keys(item)[0]; // Extracts the quality badge text (e.g. '720', '1080')
            const kwikData = item[qualityKey];
            
            if (kwikData && kwikData.kwik) {
                const kwikEmbedUrl = kwikData.kwik;
                const masterM3u8 = await resolveKwikEmbed(kwikEmbedUrl);
                
                if (masterM3u8) {
                    streams.push({
                        title: `Kwik (${qualityKey}p)`,
                        streamUrl: masterM3u8,
                        headers: {
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                            "Referer": "https://kwik.cx",
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
