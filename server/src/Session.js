const axios = require('axios');
const Engine = require('mcl-bbl-engine');
const path = require('path');
const fs = require('node:fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { cleanFilename, sanitizePath, Semaphore } = require('./utils');

class Session {
    /**
     * 
     * @param {Engine} bblSession 
     */
    constructor(bblSession, { dataPath }) {
        this.bblSession = bblSession;
        this.termData = this.bblSession._getCurrentTerm();
        this.username = bblSession.session.username;
        this.rootDataPath = path.join(dataPath, this.username);
        this.dataPath = path.join(dataPath, this.username, `${this.termData.academicYear}.${this.termData.term}`.replaceAll('.', ' '));
        this.syncStatePath = path.join(this.dataPath, '.sync-state.json');
        
        const parallelDownloads = parseInt(process.env.PARALLEL_DOWNLOADS) || 5;
        this.fileSemaphore = new Semaphore(parallelDownloads);
        this.toolSemaphore = new Semaphore(1);
        this.downloadTasks = [];
        
        this.axios = axios.create({
                validateStatus: () => true
            });

        this.initializeDataDirectory();
        this.syncState = this.loadSyncState();
    }

    initializeDataDirectory() {
        if (!fs.existsSync(this.rootDataPath)) {
            fs.mkdirSync(this.rootDataPath, { recursive: true });
        }

        if (!fs.existsSync(this.dataPath)) {
            fs.mkdirSync(this.dataPath, { recursive: true });
        }
    }

    loadSyncState() {
        if (fs.existsSync(this.syncStatePath)) {
            try {
                return JSON.parse(fs.readFileSync(this.syncStatePath, 'utf8'));
            } catch (e) {
                console.error('[Warning] Failed to parse sync state, starting fresh.');
            }
        }
        return {};
    }

    saveSyncState(immediate = false) {
        if (immediate) {
            if (this._saveTimeout) clearTimeout(this._saveTimeout);
            fs.writeFileSync(this.syncStatePath, JSON.stringify(this.syncState, null, 2));
            this._saveTimeout = null;
            return;
        }

        if (this._saveTimeout) clearTimeout(this._saveTimeout);
        this._saveTimeout = setTimeout(() => {
            fs.writeFileSync(this.syncStatePath, JSON.stringify(this.syncState, null, 2));
            this._saveTimeout = null;
        }, 1000); 
    }

    /**
     * Get the direct download URL for a lesson file
     * @param {Object} item - The lesson item data
     * @returns {string|null} - The full URL or null if not a file
     */
    getLessonFileLink(item) {
        if (item.contentHandler !== 'resource/x-bb-file') return null;
        try {
            const fileLink = item.contentDetail["resource/x-bb-file"].file.permanentUrl;
            return `https://mcl.blackboard.com${fileLink}?xythos-download=true`;
        } catch (e) {
            return null;
        }
    }

    /**
     * Download a file from a URL to a local path
     * @param {string} url 
     * @param {string} destPath 
     * @returns {Promise<boolean>}
     */
    async downloadFile(url, destPath) {
        try {
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }

            // Retrieve cookies from the active Blackboard session
            const cookieString = this.bblSession.session.cookie;

            const response = await this.axios.get(url, {
                responseType: 'stream',
                maxRedirects: 10,
                headers: {
                    'Cookie': cookieString
                }
            });

            if (response.status !== 200) {
                console.error(`[Error] Failed to download file: ${url} (Status: ${response.status})`);
                return false;
            }

            const writer = fs.createWriteStream(destPath);
            response.data.pipe(writer);

            return new Promise((resolve) => {
                writer.on('finish', () => resolve(true));
                writer.on('error', (err) => {
                    console.error('[Error] Writing file:', err);
                    resolve(false);
                });
            });
        } catch (error) {
            console.error('[Error] Downloading file:', error.message);
            return false;
        }
    }

    /**
     * Recursively iterates through the course contents tree sequentially.
     * @param {Array} data - The array of course content objects
     * @param {Function} callback - Async function executed for each item: (item, path) => Promise
     */
    async _iterateContents(data, callback) {
        for (const courseEntry of data) {
            const coursePath = cleanFilename(courseEntry.course.title);
            
            // Execute callback for the root course folder itself (to generate its index.jsonl)
            await callback({
                contentHandler: 'course-root',
                title: courseEntry.course.title,
                children: courseEntry.contents
            }, coursePath);

            const processItems = async (items, currentPath) => {
                for (const item of items) {
                    const itemPath = path.join(currentPath, cleanFilename(item.title));

                    // 1. Await the callback for the current item
                    await callback(item, itemPath);

                    // 2. Recurse deeper
                    if (item.children && item.children.length > 0) {
                        await processItems(item.children, itemPath);
                    }
                }
            };

            if (courseEntry.contents) {
                await processItems(courseEntry.contents, coursePath);
            }
        }
    }

    /**
     * Sync course contents by creating local structure, downloading files, and resolving links.
     * @param {string} [courseId] - Optional course ID to sync only a specific course.
     */
    async sync(courseId = null) {
        let courses = await this.bblSession.getCourses();
        
        if (courseId) {
            courses = courses.filter(c => c.id === courseId);
        }

        const courseContents = [];
        for (const course of courses) {
            console.log(`[Syncing Course] ${course.originalId}`);
            const contents = await this.bblSession.getCourseContents(course.id);
            courseContents.push({
                course: {
                    title: course.originalId,
                    id: course.id
                },
                contents
            });
        }

        await this._iterateContents(courseContents, async (item, itemPath) => {
            const safeItemPath = sanitizePath(itemPath);
            const fullPath = path.join(this.dataPath, safeItemPath);
            const handler = item.contentHandler;
            const itemId = item.id;
            const itemModified = item.modifiedDate || 0;

            const isFolder = ['resource/x-bb-folder', 'resource/x-bb-lesson', 'course-root'].includes(handler) || item.children;

            // 1. FOLDERS & LESSONS (Always process to maintain tree and update index.jsonl)
            if (isFolder) {
                if (!fs.existsSync(fullPath)) {
                    fs.mkdirSync(fullPath, { recursive: true });
                }

                // Generate index.jsonl for the folder
                const indexPath = path.join(fullPath, 'index.jsonl');
                fs.writeFileSync(indexPath, ''); // Clear or create empty file
                
                if (item.children && item.children.length > 0) {
                    for (const child of item.children) {
                        fs.appendFileSync(indexPath, JSON.stringify(child) + '\n');
                    }
                }
            } 

            // Stop processing if it's strictly a structural item
            if (['course-root', 'resource/x-bb-folder', 'resource/x-bb-lesson', 'resource/x-bb-courselink'].includes(handler)) {
                return;
            }

            // -- Check Sync State for Expensive Operations --
            const isSynced = this.syncState[itemId] === itemModified;
            let needsSync = !isSynced;

            // 2. FILES
            if (handler === 'resource/x-bb-file') {
                if (!needsSync && !fs.existsSync(fullPath)) needsSync = true; // File missing locally
                if (!needsSync) return console.log(`[Skipped] ${safeItemPath}`);

                const fileUrl = this.getLessonFileLink(item);
                if (fileUrl) {
                    this.downloadTasks.push(this.fileSemaphore.run(async () => {
                        console.log(`[Downloading File] ${safeItemPath}`);
                        const success = await this.downloadFile(fileUrl, fullPath);
                        if (success && itemId) {
                            this.syncState[itemId] = itemModified;
                            this.saveSyncState();
                        }
                    }));
                }
            } 
            
            // 3. EXTERNAL LINKS
            else if (handler === 'resource/x-bb-externallink') {
                const url = item.url || (item.contentDetail && item.contentDetail["resource/x-bb-externallink"]?.url) || "";
                if (!url) return console.warn(`[Warning] External link missing URL for item: ${safeItemPath}`);

                let expectedPath = fullPath;
                let isCanva = false;
                let isGdown = false;

                if (url.includes('drive.google.com')) {
                    isGdown = true;
                } else if (url.includes('canva.com')) {
                    isCanva = true;
                    expectedPath = fullPath.toLowerCase().endsWith('.gif') ? fullPath : fullPath + '.gif';
                } else {
                    expectedPath = fullPath + '.txt';
                }

                if (!needsSync && !fs.existsSync(expectedPath)) needsSync = true;
                if (!needsSync) return console.log(`[Skipped] ${safeItemPath}`);

                this.downloadTasks.push((async () => {
                    if (isGdown) {
                        const isDir = url.includes('/folders/') || url.includes('id=');
                        const flag = isDir ? '--folder' : '';
                        const cmd = `gdown "${url}" -O "${fullPath}" ${flag}`.trim();
                        
                        await this.toolSemaphore.run(async () => {
                            console.log(`[Google Drive] Shelling out: ${cmd}`);
                            try { await execAsync(cmd); } catch(e) { console.error(`[Error] gdown failed for ${url}`); }
                        });
                    } else if (isCanva) {
                        let canvaUrl = url;
                        if (canvaUrl.includes('/view')) {
                            canvaUrl = canvaUrl.split('/view')[0] + '/view?embed';
                        } else {
                            canvaUrl = canvaUrl + '/view?embed';
                        }
                        const cmd = `canva-dl "${canvaUrl}" --output "${expectedPath}" --fps 10 --threads 2`;
                        
                        await this.toolSemaphore.run(async () => {
                            console.log(`[Canva] Shelling out: ${cmd}`);
                            try { await execAsync(cmd); } catch(e) { console.error(`[Error] canva-dl failed for ${canvaUrl}`); }
                        });
                    } else {
                        fs.writeFileSync(expectedPath, url);
                    }

                    if (itemId) {
                        this.syncState[itemId] = itemModified;
                        this.saveSyncState();
                    }
                })());
            } 
            
            // 4. TEST / ASSIGNMENT LINKS
            else if (handler === 'resource/x-bb-asmt-test-link') {
                if (!needsSync && !fs.existsSync(fullPath + '.txt')) needsSync = true;
                if (!needsSync) return console.log(`[Skipped] ${safeItemPath}`);

                const url = item.url || `https://mcl.blackboard.com/webapps/assessment/take/launch.jsp?course_id=${item.courseId}&content_id=${item.id}`;
                fs.writeFileSync(`${fullPath}.txt`, url);

                if (itemId) {
                    this.syncState[itemId] = itemModified;
                    this.saveSyncState();
                }
            } 
            
            // 5. DOCUMENTS (Canva Extraction and Embedded Files)
            else if (handler === 'resource/x-bb-document') {
                if (!needsSync) return console.log(`[Skipped] ${safeItemPath}`);

                console.log(`[Processing Document] ${safeItemPath}`);
                const rawText = item.body?.rawText || "";
                
                // Extract unique DAV links
                const davRegex = /https:\/\/mcl\.blackboard\.com\/bbcswebdav\/[^\s"'>?]+/g;
                const uniqueDavLinks = [...new Set(rawText.match(davRegex) || [])];

                this.downloadTasks.push((async () => {
                    for (let i = 0; i < uniqueDavLinks.length; i++) {
                        const davLink = uniqueDavLinks[i].replace(/&quot;/g, '"');
                        
                        // Attempt to extract filename from the surrounding HTML tag
                        let filename = null;
                        const escapedLink = davLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const tagRegex = new RegExp(`<a[^>]*href="${escapedLink}[^"]*"[^>]*>`);
                        const tagMatch = rawText.match(tagRegex);
                        
                        if (tagMatch) {
                            const bbfileMatch = tagMatch[0].match(/data-bbfile="([^"]*)"/);
                            if (bbfileMatch) {
                                try {
                                    const bbdata = JSON.parse(bbfileMatch[1].replace(/&quot;/g, '"'));
                                    filename = bbdata.linkName || bbdata.fileName || bbdata.displayName || bbdata.alternativeText;
                                } catch(e) {}
                            }
                        }
                        
                        if (!filename) {
                            const parts = davLink.split('/');
                            filename = parts[parts.length - 1] + '.file';
                        }
                        filename = cleanFilename(filename);

                        try {
                            // Determine content type safely using fileSemaphore to limit connections
                            let contentType = '';
                            await this.fileSemaphore.run(async () => {
                                const headResponse = await this.axios.head(davLink, {
                                    headers: { 'Cookie': this.bblSession.session.cookie }
                                });
                                contentType = headResponse.headers['content-type'] || '';
                            });

                            if (contentType.includes('text/html')) {
                                // It's likely a Canva embed page
                                let responseData = '';
                                await this.fileSemaphore.run(async () => {
                                    const response = await this.axios.get(davLink, {
                                        headers: { 'Cookie': this.bblSession.session.cookie }
                                    });
                                    if (response.status === 200 && typeof response.data === 'string') {
                                        responseData = response.data;
                                    }
                                });

                                if (responseData) {
                                    const canvaRegex = /https:\/\/www\.canva\.com\/design\/[^\s"'>]+/g;
                                    const canvaLinks = responseData.match(canvaRegex) || [];

                                    for (let j = 0; j < canvaLinks.length; j++) {
                                        let canvaUrl = canvaLinks[j];
                                        if (canvaUrl.includes('/view')) {
                                            canvaUrl = canvaUrl.split('/view')[0] + '/view?embed';
                                        } else if (!canvaUrl.includes('?embed')) {
                                            canvaUrl = canvaUrl + '/view?embed';
                                        }

                                        const suffix = (uniqueDavLinks.length > 1 || canvaLinks.length > 1) ? `_${i}_${j}` : '';
                                        const outPath = `${fullPath}${suffix}.gif`;
                                        
                                        const cmd = `canva-dl "${canvaUrl}" --output "${outPath}" --fps 10`;
                                        await this.toolSemaphore.run(async () => {
                                            console.log(`[Canva from Doc] Shelling out: ${cmd}`);
                                            try { await execAsync(cmd); } catch(e) { console.error(`[Error] canva-dl failed for ${canvaUrl} in doc`); }
                                        });
                                    }
                                }
                            } else {
                                // It's a direct file (PDF, MP4, etc.)
                                const outPath = path.join(fullPath, filename);
                                
                                // Check if we need to sync this specific file
                                if (!fs.existsSync(outPath)) {
                                    await this.fileSemaphore.run(async () => {
                                        console.log(`[Downloading Embedded File] ${filename}`);
                                        await this.downloadFile(davLink, outPath);
                                    });
                                } else {
                                    console.log(`[Skipped Embedded File] ${filename} (Already exists)`);
                                }
                            }
                        } catch (e) {
                            console.error(`[Error] Failed to process DAV link ${davLink}: ${e.message}`);
                        }
                    }

                    if (itemId) {
                        this.syncState[itemId] = itemModified;
                        this.saveSyncState();
                    }
                })());
            } 
            
            // 7. UNKNOWN / FALLBACK
            else {
                console.warn(`[Warning] Unhandled content type: ${handler} for item ${safeItemPath}`);
            }
        });

        console.log("[Sync] Discovered all items. Waiting for background downloads to finish...");
        await Promise.all(this.downloadTasks);
        this.saveSyncState(true);
        console.log("[Sync] Completed successfully.");
    }
}

module.exports = Session;
