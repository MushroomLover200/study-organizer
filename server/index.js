const Engine = require('mcl-bbl-engine');
const fs = require('node:fs');
const path = require('path');
require('dotenv').config();


const axios = require('axios').create({
    validateStatus: () => true
})

function downloadFile(url, path) {
    return new Promise(async (resolve, reject) => {
        try {
            const response = await axios.get(url, {
                responseType: 'stream', // Allows downloading files as a stream
                maxRedirects: 10 // Optional: limit the number of redirects
            });

            // Create a write stream to save the file
            const writer = fs.createWriteStream(path);

            // Pipe the response data to the file
            response.data.pipe(writer);

            writer.on('finish', () => {
                console.log('Download completed!');
                resolve(true);
            });

            writer.on('error', (err) => {
                console.error('Error writing file:', err);
                resolve(false);
            });
        } catch (error) {
            console.error('Error downloading the file:', error.message);
            resolve(false);
        }
    })
}

/**
 * Clean a string
 * @param {string} string - the string to replace 
 * @returns {string} - returns a cleaned string
 */
function cleanFilename(string) {
    if (typeof string !== 'string') return '';
    return string.replaceAll(/[<>:"\/\\|?*\x00-\x1F]/g, '');
}

/**
 * Recursively iterates through the course contents tree sequentially.
 * @param {Array} data - The array returned by getCourseContents()
 * @param {Function} callback - Async function executed for each item: (item, path) => Promise
 */
async function iterateContents(data, callback) {
    for (const courseEntry of data) {
        // Root path starts with the course title (cleaned for the filesystem)
        const coursePath = cleanFilename(courseEntry.course.title);

        async function processItems(items, currentPath) {
            for (const item of items) {
                // Construct the full path for this specific item
                const itemPath = path.join(currentPath, cleanFilename(item.title));

                // 1. Await the callback for the current item (Sequential)
                await callback(item, itemPath);

                // 2. If children exist, recurse deeper before moving to the next sibling
                if (item.children && item.children.length > 0) {
                    await processItems(item.children, itemPath);
                }
            }
        }

        if (courseEntry.contents) {
            await processItems(courseEntry.contents, coursePath);
        }
    }
}

/**
 * 
 * @param {Object} lessonData 
 */
async function getLessonFileLink(lessonData) {
    let fileLink = lessonData.contentDetail["resource/x-bb-file"].file.permanentUrl;
    let fileURL = new URL('https://mcl.blackboard.com' +fileLink+ '?xythos-download=true');
    

    // returns something like
    // https://mcl.blackboard.com/bbcswebdav/pid-2604812-dt-content-rid-112194099_1/xid-112194099_1?xythos-download=true
    return fileURL;
}

async function main(params) {
    const bbl = await Engine.create({ username: process.env.BBL_USERNAME, password: process.env.BBL_PASSWORD });


    async function getCourseContents() {
        let courses = await bbl.getCourses();
        let course_contents = [];
        for (let course of courses) {
            let contents = await bbl.getCourseContents(course.id)
            console.log(await bbl.getCourseContents(course.id, true))

            console.log(contents[0]);

            course_contents.push({
                course: {
                    title: course.originalId,
                    id: course.id
                },
                contents
            });
        }

        return course_contents;
    }


    let contents = (await getCourseContents());

    fs.writeFileSync('./contents.json', JSON.stringify(contents, null, 2));

    console.log('Iterating through contents:');
    await iterateContents(contents, async (item, itemPath) => {
        // console.log(`Processing: ${itemPath} ${item.contentHandler}`);

        if(item.contentHandler === 'resource/x-bb-file') {
            console.log(await getLessonFileLink(item));
        }
    });

    await bbl.close();
}

main();