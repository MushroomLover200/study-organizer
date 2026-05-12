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
async function main() {
    checkSystemRequirements();

    const bbl = await Engine.create({ 
        username: process.env.BBL_USERNAME, 
        password: process.env.BBL_PASSWORD 
    });
    
    const session = new Session(bbl, { dataPath: DATA_DIR });
    
    console.log(`[Session] Academic Year: ${session.termData.academicYear}, Term: ${session.termData.term}`);

    try {
        await session.sync();

        console.log('[Analyzer] Sync complete. Starting analysis pipeline...');
        const GeminiAnalyzer = require('./src/GeminiAnalyzer');
        const analyzer = new GeminiAnalyzer(process.env.GEMINI_API_KEY);
        await analyzer.runPipeline(session.dataPath);
        console.log('[Analyzer] Analysis pipeline completed.');
        
    } catch (error) {
        console.error('[Fatal Error] Sync or Analysis failed:', error);
    } finally {
        await bbl.close();
    }
}

main();