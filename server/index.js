const Engine = require('mcl-bbl-engine');
const fs = require('node:fs');
const path = require('path');
require('dotenv').config();
const express = require('express');
const Session = require('./src/Session');
const { cleanFilename } = require('./src/utils');
const { execSync } = require('child_process');


const ROOT_DIR = path.join(__dirname, '../');
const SERVER_DIR = path.join(ROOT_DIR, './server');
const DATA_DIR = path.join(ROOT_DIR, './data');

/**
 * Checks if required system dependencies are installed before proceeding.
 */
function checkSystemRequirements() {
    try {
        execSync('which gdown', { stdio: 'ignore' });
    } catch (e) {
        console.error('Fatal Error: "gdown" is not installed or not in PATH.');
        console.error('Please install it (e.g., pip install gdown) to proceed.');
        process.exit(1);
    }

    try {
        execSync('which canva-dl', { stdio: 'ignore' });
    } catch (e) {
        console.error('Fatal Error: "canva-dl" is not installed or not in PATH.');
        console.error('Please install it from https://github.com/MushroomLover200/canva-downloader to proceed.');
        process.exit(1);
    }
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
    let fileURL = new URL('https://mcl.blackboard.com' + fileLink + '?xythos-download=true');


    // returns something like
    // https://mcl.blackboard.com/bbcswebdav/pid-2604812-dt-content-rid-112194099_1/xid-112194099_1?xythos-download=true
    return fileURL;
}



async function main(params) {
    checkSystemRequirements();

    const bbl = await Engine.create({ username: process.env.BBL_USERNAME, password: process.env.BBL_PASSWORD });
    const session = new Session(bbl, { dataPath: DATA_DIR });
    console.log(bbl._getCurrentTerm())



    // temporary function
    async function getCourseContents() {
        let courses = await bbl.getCourses();
        let course_contents = [];
        for (let course of courses) {
            // let contents = await bbl.getCourseContents(course.id)
            console.log(await bbl.getCourseContents(course.id, true)) // here for printing the tree and stuff

            // course_contents.push({
            //     course: {
            //         title: course.originalId,
            //         id: course.id
            //     },
            //     contents
            // });
        }

        // return course_contents;
    }
    // await getCourseContents();
    await session.sync();
    await bbl.close();
    // const app = express();


    // app.listen(5000);
}

main();