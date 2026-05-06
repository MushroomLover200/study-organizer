const axios = require('axios');
const Engine = require('mcl-bbl-engine');
const path = require('path');
const fs = require('node:fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { cleanFilename, sanitizePath } = require('./utils');

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
        
        this.axios = axios.create({
                validateStatus: () => true
            });

        this.initializeDataDirectory();
    }

    initializeDataDirectory() {
        if (!fs.existsSync(this.rootDataPath)) {
            fs.mkdirSync(this.rootDataPath, { recursive: true });
        }

        if (!fs.existsSync(this.dataPath)) {
            fs.mkdirSync(this.dataPath, { recursive: true });
        }
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

            // 1. FOLDERS & LESSONS (and root course folders)
            if (['resource/x-bb-folder', 'resource/x-bb-lesson', 'course-root'].includes(handler) || item.children) {
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
            
            // 2. FILES
            else if (handler === 'resource/x-bb-file') {
                const fileUrl = this.getLessonFileLink(item);
                if (fileUrl) {
                    // Blackboard item titles often contain the extension.
                    console.log(`[Downloading File] ${safeItemPath}`);
                    await this.downloadFile(fileUrl, fullPath);
                }
            } 
            
            // 3. EXTERNAL LINKS
            else if (handler === 'resource/x-bb-externallink') {
                // Safely extract URL from item properties
                const url = item.url || (item.contentDetail && item.contentDetail["resource/x-bb-externallink"]?.url) || "";
                
                if (!url) {
                    console.warn(`[Warning] External link missing URL for item: ${safeItemPath}`);
                    return;
                }

                if (url.includes('drive.google.com')) {
                    const isFolder = url.includes('/folders/') || url.includes('id=');
                    const flag = isFolder ? '--folder' : '';
                    const cmd = `gdown "${url}" -O "${fullPath}" ${flag}`.trim();
                    console.log(`[Google Drive] Shelling out: ${cmd}`);
                    try { 
                        await execAsync(cmd); 
                    } catch(e) { 
                        console.error(`[Error] gdown failed for ${url}`); 
                    }
                } else if (url.includes('canva.com')) {
                    let canvaUrl = url;
                    if (canvaUrl.includes('/view')) {
                        canvaUrl = canvaUrl.split('/view')[0] + '/view?embed';
                    } else {
                        canvaUrl = canvaUrl + '/view?embed'; // rough fallback
                    }
                    const outPath = fullPath.endsWith('.mp4') ? fullPath : fullPath + '.mp4';
                    const cmd = `canva-dl "${canvaUrl}" --output "${outPath}" --fps 10`;
                    console.log(`[Canva] Shelling out: ${cmd}`);
                    try { 
                        await execAsync(cmd); 
                    } catch(e) { 
                        console.error(`[Error] canva-dl failed for ${canvaUrl}`); 
                    }
                } else {
                    // Generic link
                    fs.writeFileSync(`${fullPath}.txt`, url);
                }
            } 
            
            // 4. TEST / ASSIGNMENT LINKS
            else if (handler === 'resource/x-bb-asmt-test-link') {
                const url = item.url || `https://mcl.blackboard.com/webapps/assessment/take/launch.jsp?course_id=${item.courseId}&content_id=${item.id}`;
                fs.writeFileSync(`${fullPath}.txt`, url);
            } 
            
            // 5. DOCUMENTS
            else if (handler === 'resource/x-bb-document') {
                console.log(`[Skipping Document] ${safeItemPath}`);
            } 
            
            // 6. COURSE LINKS
            else if (handler === 'resource/x-bb-courselink') {
                // Ignore course links
            } 
            
            // 7. UNKNOWN / FALLBACK
            else {
                console.warn(`[Warning] Unhandled content type: ${handler} for item ${safeItemPath}`);
            }
        });

        console.log('[Sync] Completed successfully.');
    }
}

module.exports = Session;