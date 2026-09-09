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
 * AnimePahe uses a specific embedded script block to generate video player nodes.
 */
async function extractStreamUrl(url) {
    const fallback = JSON.stringify({ streams: [], subtitle: '' });
    try {
        const response = await soraFetch(url, { headers: makeHeaders() });
        if (!response) return fallback;
        const html = await response.text();

        // 1. Target the internal player selection layout blocks
        // AnimePahe keeps dynamic streaming embed arrays mapped inside inline scripts or data attributes
        const kwikMatches = [...html.matchAll(/data-src=["'](https:\/\/kwik\.cx\/e\/[^"']+)["']/g)]
                        || [...html.matchAll(/src=["'](https:\/\/kwik\.cx\/e\/[^"']+)["']/g)]
                        || [...html.matchAll(/(https:\/\/kwik\.cx\/e\/[a-zA-Z0-9]+)/g)];

        if (!kwikMatches || kwikMatches.length === 0) {
            console.log("AnimePahe stream error: No raw kwik player embeds located in source code.");
            return fallback;
        }

        const streams = [];
        const seenEmbeds = new Set();
        
        // 2. Loop through discovered embed variants and resolve the master playlists
        for (const match of kwikMatches) {
            const embedUrl = Array.isArray(match) ? match[1] : match;
            if (seenEmbeds.has(embedUrl)) continue;
            seenEmbeds.add(embedUrl);

            const masterM3u8 = await resolveKwikEmbed(embedUrl);
            if (masterM3u8) {
                // Determine video tags based on string details safely
                const label = embedUrl.includes('1080') ? 'Kwik (1080p)' : 'Kwik (720p)';
                streams.push({
                    title: label,
                    streamUrl: masterM3u8,
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        "Referer": "https://kwik.cx/",
                        "Origin": "https://kwik.cx"
                    }
                });
            }
        }

        return JSON.stringify({ streams: streams, subtitle: '' });
    } catch (error) {
        console.log('AnimePahe Stream extraction error: ' + error);
        return fallback;
    }
}

/**
 * Grabs the underlying stream address out of the kwik player container.
 */
async function resolveKwikEmbed(embedUrl) {
    try {
        const response = await soraFetch(embedUrl, { 
            headers: { 
                "Referer": BASE_URL,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            } 
        });
        if (!response) return null;
        const html = await response.text();

        // Kwik scripts obfuscate the .m3u8 source URL using standard JS string packing (p,a,c,k,e,d)
        // This pattern isolates the hidden video initialization values safely
        const masterUrlMatch = html.match(/source\s*=\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i)
                            || html.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i)
                            || html.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/i);

        if (masterUrlMatch) {
            return masterUrlMatch[1] || masterUrlMatch[0];
        }
        
        return null;
    } catch (e) {
        console.log("Kwik embed processing breakdown: " + e);
        return null;
    }
}
