// animepahe.js
const BASE_URL = 'https://animepahe.com';
const SEARCH_API = `${BASE_URL}/api?m=search&q=`;
const EPISODE_API = `${BASE_URL}/api?m=release&id=`;

/* ==========================================================================
   MAIN EXTENSION FUNCTIONS
   ========================================================================== */

/**
 * Searches animepahe.com using its public internal JSON endpoint.
 * @returns {string} JSON string array of {title, image, href} objects.
 */
async function searchResults(keyword) {
    try {
        const query = (keyword || '').trim();
        if (!query) return JSON.stringify([]);

        // Explicitly encode components to completely prevent NXDOMAIN/hostname typos
        const requestUrl = `${SEARCH_API}${encodeURIComponent(query)}`;
        const response = await soraFetch(requestUrl, { headers: makeHeaders() });
        if (!response) return JSON.stringify([]);
        
        const json = await response.json();
        if (!json || !Array.isArray(json.data)) return JSON.stringify([]);

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

        // Extract using regex layers similar to your template
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
 * @returns {string} JSON string array of {href, number} objects.
 */
async function extractEpisodes(url) {
    try {
        const response = await soraFetch(url, { headers: makeHeaders() });
        if (!response) return JSON.stringify([]);
        const html = await response.text();

        // AnimePahe embeds a release ID variable in their raw HTML profile scripts
        const idMatch = html.match(/let\s+id\s*=\s*["']([^"']+)["']/i) 
                     || html.match(/&id=([a-f0-9\-]+)/i);
        if (!idMatch) return JSON.stringify([]);
        const animeId = idMatch[1];

        // Fetch page 1 of the releases API (Contains up to 30 episodes usually)
        const apiResponse = await soraFetch(`${EPISODE_API}${animeId}&sort=episode_asc&page=1`, { headers: makeHeaders() });
        if (!apiResponse) return JSON.stringify([]);
        const json = await apiResponse.json();

        if (!json || !Array.isArray(json.data)) return JSON.stringify([]);

        const episodes = json.data.map(ep => ({
            href: `${url}/${ep.session}`, // Formulates unique Sora item context tracking
            number: parseInt(ep.episode, 10) || 1
        }));

        return JSON.stringify(episodes);
    } catch (error) {
        console.log('AnimePahe Episodes error: ' + error);
        return JSON.stringify([]);
    }
}

/**
 * Resolves an individual episode page into streamable HLS links.
 * AnimePahe redirects playback execution out to Kwik embed engines.
 */
async function extractStreamUrl(url) {
    const fallback = JSON.stringify({ streams: [], subtitle: '' });
    try {
        const response = await soraFetch(url, { headers: makeHeaders() });
        if (!response) return fallback;
        const html = await response.text();

        // Search the source HTML for the kwik.cx stream player embeds
        const kwikMatches = [...html.matchAll(/href=["'](https:\/\/kwik\.cx\/e\/[^"']+)["']/g)];
        if (kwikMatches.length === 0) return fallback;

        const streams = [];
        
        // Resolve playlists across multiple quality targets (e.g. 720p vs 1080p outputs found on-page)
        for (const match of kwikMatches) {
            const embedUrl = match[1];
            const masterM3u8 = await resolveKwikEmbed(embedUrl);
            
            if (masterM3u8) {
                streams.push({
                    title: embedUrl.includes('1080') ? 'Kwik (1080p)' : 'Kwik (720p)',
                    streamUrl: masterM3u8,
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                        "Referer": "https://kwik.cx"
                    }
                });
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
        const response = await soraFetch(embedUrl, { headers: { "Referer": BASE_URL } });
        if (!response) return null;
        const html = await response.text();

        // Kwik scripts obfuscate the raw stream string via custom packed JS blocks.
        // This evaluations safely tracks down the source evaluation pattern.
        const packedScript = extractFirst(html, /(eval\(function\(p,a,c,k,e,d\)[\s\S]*?<\/script>)/i);
        if (!packedScript) return null;

        // Locates the underlying master index manifest parameter
        const directUrl = extractFirst(packedScript, /(https?:\/\/[^"']+\.m3u8[^"']*)/i);
        return directUrl || null;
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
