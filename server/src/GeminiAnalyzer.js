const { GoogleGenAI } = require('@google/genai');
const fs = require('node:fs');
const path = require('path');
const { z } = require('zod');

// Schema for a grounded lesson analysis using Zod as per GEMINI.md
const LessonSchema = z.object({
    title: z.string(),
    briefOverview: z.string(),
    contentBlocks: z.array(z.object({
        type: z.enum([
            'concept', 
            'process', 
            'definition', 
            'example', 
            'historical_context', 
            'code_snippet', 
            'formula', 
            'case_study', 
            'discussion_point'
        ]),
        heading: z.string().describe("A specific, descriptive heading for this block based on the material."),
        details: z.array(z.string()).describe("Detailed bullet points extracted directly from the source material."),
        sourceReference: z.string().optional().describe("Which file or slide this information came from, if identifiable.")
    })),
    synthesis: z.object({
        keyTakeaways: z.array(z.string()),
        unansweredQuestions: z.array(z.string()).describe("Concepts mentioned but not fully explained in the material.")
    })
});

/**
 * GeminiAnalyzer is responsible for hierarchically formatting course content.
 */
class GeminiAnalyzer {
    constructor(apiKey) {
        this.ai = new GoogleGenAI({ apiKey });
        
        // Load configuration
        const configPath = path.join(__dirname, '../analyzer-config.json');
        this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    /**
     * Determines the mime type for a file based on its extension.
     */
    getMimeType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeMap = {
            '.pdf': 'application/pdf',
            '.mp4': 'video/mp4',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.txt': 'text/plain',
            '.jsonl': 'text/plain',
            '.md': 'text/markdown'
        };
        return mimeMap[ext] || 'application/octet-stream';
    }

    /**
     * Uploads a file to Gemini and returns the file object.
     * Waits for the file to be in ACTIVE state.
     */
    async uploadFile(filePath) {
        const mimeType = this.getMimeType(filePath);
        // Only upload supported multimodal types
        if (!['application/pdf', 'video/mp4', 'image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
            return null;
        }

        console.log(`[Analyzer] Uploading ${path.basename(filePath)} (${mimeType})...`);
        try {
            // Sanitize displayName to avoid ByteString errors (replace non-ASCII)
            const displayName = path.basename(filePath).replace(/[^\x00-\x7F]/g, '_');
            
            let file = await this.ai.files.upload({
                file: filePath,
                config: {
                    mimeType,
                    displayName,
                }
            });
            console.log(`[Analyzer] Uploaded: ${file.name}. Waiting for ACTIVE state...`);

            // Polling for ACTIVE state with timeout (10 minutes)
            const pollStartTime = Date.now();
            while (file.state === 'PROCESSING' && (Date.now() - pollStartTime) < 600000) {
                process.stdout.write('.');
                await new Promise(resolve => setTimeout(resolve, 5000)); // Poll every 5s
                file = await this.ai.files.get({ name: file.name });
            }

            if (file.state === 'FAILED') {
                throw new Error(`File ${file.name} failed to process.`);
            }

            console.log(`\n[Analyzer] File ${file.name} is now ACTIVE.`);
            return file;
        } catch (error) {
            console.error(`[Analyzer] Upload/Processing failed for ${filePath}:`, error.message);
            return null;
        }
    }

    /**
     * Recursively gathers all files in a folder, including ultraDocumentBody if present.
     */
    gatherFiles(folderPath, filesList = []) {
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(folderPath, entry.name);
            if (entry.isDirectory()) {
                // We recurse into all subdirectories for a lesson's content
                this.gatherFiles(fullPath, filesList);
            } else {
                filesList.push(fullPath);
            }
        }
        return filesList;
    }

    /**
     * Formats the structured JSON output into Markdown.
     */
    jsonToMarkdown(data) {
        let md = `# ${data.title}\n\n`;
        md += `*Overview: ${data.briefOverview}*\n\n`;

        if (data.contentBlocks) {
            for (const block of data.contentBlocks) {
                md += `## ${block.heading} *(${block.type})*\n`;
                for (const detail of block.details) {
                    md += `* ${detail}\n`;
                }
                if (block.sourceReference) {
                    md += `> Source: ${block.sourceReference}\n`;
                }
                md += `\n`;
            }
        }

        md += `---\n## Synthesis\n`;
        md += `### Key Takeaways\n`;
        if (data.synthesis?.keyTakeaways) {
            for (const takeaway of data.synthesis.keyTakeaways) {
                md += `* ${takeaway}\n`;
            }
        }

        if (data.synthesis?.unansweredQuestions && data.synthesis.unansweredQuestions.length > 0) {
            md += `\n### Noted Gaps / Unanswered Questions\n`;
            for (const question of data.synthesis.unansweredQuestions) {
                md += `* ${question}\n`;
            }
        }

        return md;
    }

    /**
     * Analyzes a leaf lesson folder.
     */
    async analyzeLesson(folderPath) {
        console.log(`[Analyzer] Processing Lesson: ${folderPath}`);
        
        const allFiles = this.gatherFiles(folderPath);
        const uploadedFiles = [];
        const parts = [];

        try {
            for (const file of allFiles) {
                const mimeType = this.getMimeType(file);
                const fileName = path.basename(file);

                if (fileName === 'analysis.md' || fileName === 'analysis.json' || fileName === '.sync-state.json') continue;

                if (['text/plain', 'text/markdown'].includes(mimeType)) {
                    const text = fs.readFileSync(file, 'utf8');
                    parts.push({ text: `--- Content from ${fileName} ---\n${text}` });
                } else {
                    const uploaded = await this.uploadFile(file);
                    if (uploaded) {
                        uploadedFiles.push(uploaded);
                        parts.push({ fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType } });
                    }
                }
            }

            if (parts.length === 0) {
                console.log(`[Analyzer] No processable content in ${folderPath}, skipping.`);
                return;
            }

            // Manual schema construction to ensure compatibility with Gemini API
            const jsonSchema = {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    briefOverview: { type: 'string' },
                    contentBlocks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                type: { type: 'string', enum: ['concept', 'process', 'definition', 'example', 'historical_context', 'code_snippet', 'formula', 'case_study', 'discussion_point'] },
                                heading: { type: 'string' },
                                details: { type: 'array', items: { type: 'string' } },
                                sourceReference: { type: 'string' }
                            },
                            required: ['type', 'heading', 'details']
                        }
                    },
                    synthesis: {
                        type: 'object',
                        properties: {
                            keyTakeaways: { type: 'array', items: { type: 'string' } },
                            unansweredQuestions: { type: 'array', items: { type: 'string' } }
                        },
                        required: ['keyTakeaways']
                    }
                },
                required: ['title', 'briefOverview', 'contentBlocks', 'synthesis']
            };

            const maxRetries = 3;
            let attempt = 0;
            let success = false;
            let structuredData = null;

            while (attempt < maxRetries && !success) {
                attempt++;
                console.log(`[Analyzer] Generation Attempt ${attempt}/${maxRetries} for ${folderPath}...`);
                console.log(`[Analyzer] Sending ${parts.length} parts to Gemini (${this.config.model}). This may take several minutes for multimodal content...`);
                const startTime = Date.now();

                try {
                    const response = await this.ai.models.generateContent({
                        model: this.config.model,
                        contents: [
                            {
                                role: 'user',
                                parts: parts
                            }
                        ],
                        config: {
                            systemInstruction: this.config.systemInstructions.lesson,
                            temperature: this.config.temperature,
                            maxOutputTokens: this.config.maxOutputTokens,
                            responseMimeType: 'application/json',
                            responseJsonSchema: jsonSchema
                        }
                    });

                    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                    console.log(`[Analyzer] Response received in ${duration}s.`);

                    // Attempt to parse response.value first (SDK parsed)
                    structuredData = response.value;

                    // Fallback to response.text parsing if value is missing or incomplete
                    if (!structuredData && response.text) {
                        try {
                            // Extract JSON if model wrapped it in markdown blocks
                            const jsonMatch = response.text.match(/```json\n?([\s\S]*?)\n?```/) || [null, response.text];
                            structuredData = JSON.parse(jsonMatch[1]);
                        } catch (e) {
                            console.warn(`[Analyzer] Attempt ${attempt} failed to parse JSON from text:`, e.message);
                        }
                    }

                    if (structuredData && structuredData.title) {
                        success = true;
                    } else {
                        console.warn(`[Analyzer] Attempt ${attempt} returned incomplete data.`);
                    }
                } catch (error) {
                    console.error(`[Analyzer] Attempt ${attempt} failed with error:`, error.message);
                    if (attempt < maxRetries) {
                        const delay = 30000; // Wait 30s before retry
                        console.log(`[Analyzer] Waiting ${delay / 1000}s before next attempt...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }

            if (!success) {
                throw new Error(`Failed to analyze lesson after ${maxRetries} attempts.`);
            }

            const markdown = this.jsonToMarkdown(structuredData);

            fs.writeFileSync(path.join(folderPath, 'analysis.md'), markdown);
            fs.writeFileSync(path.join(folderPath, 'analysis.json'), JSON.stringify(structuredData, null, 2));
            
            console.log(`[Analyzer] Successfully generated analysis.md and analysis.json for ${folderPath}`);

        } catch (error) {
            console.error(`[Analyzer] Error analyzing lesson ${folderPath}:`, error);
        } finally {
            // Robust cleanup of uploaded files
            for (const file of uploadedFiles) {
                try {
                    if (file && file.name) {
                        console.log(`[Analyzer] Deleting remote file: ${file.name}`);
                        await this.ai.files.delete({ name: file.name });
                    }
                } catch (e) {
                    console.warn(`[Analyzer] Failed to delete remote file ${file?.name}:`, e.message);
                }
            }
        }
    }

    /**
     * Synthesizes parent folder content from child analyses.
     */
    async analyzeParent(folderPath, childAnalyses) {
        console.log(`[Analyzer] Synthesizing Parent: ${folderPath}`);
        
        let synthesisPrompt = "Synthesize a higher-level summary from the following sub-lesson data:\n\n";
        for (const child of childAnalyses) {
            synthesisPrompt += `\n### Sub-Lesson: ${child.name} ###\n${JSON.stringify(child.data, null, 2)}\n`;
        }

        try {
            const response = await this.ai.models.generateContent({
                model: this.config.model,
                contents: synthesisPrompt,
                config: {
                    systemInstruction: this.config.systemInstructions.parent,
                    temperature: this.config.temperature
                }
            });
            
            fs.writeFileSync(path.join(folderPath, 'analysis.md'), response.text);
            console.log(`[Analyzer] Generated parent analysis.md for ${folderPath}`);
        } catch (error) {
            console.error(`[Analyzer] Error synthesizing parent ${folderPath}:`, error);
        }
    }

    /**
     * Recursively traverses the directory tree bottom-up.
     */
    async processTree(currentPath) {
        if (path.basename(currentPath).toUpperCase().includes('ARCHIVE')) return;

        const entries = fs.readdirSync(currentPath, { withFileTypes: true });
        // Exclude ultraDocumentBody from being treated as a separate child node
        const subdirectories = entries.filter(dirent => dirent.isDirectory() && dirent.name !== 'ultraDocumentBody');
        
        if (subdirectories.length > 0) {
            const childAnalyses = [];

            for (const dir of subdirectories) {
                const childPath = path.join(currentPath, dir.name);
                await this.processTree(childPath); 
                
                const childJsonFile = path.join(childPath, 'analysis.json');
                if (fs.existsSync(childJsonFile)) {
                    childAnalyses.push({
                        name: dir.name,
                        data: JSON.parse(fs.readFileSync(childJsonFile, 'utf8'))
                    });
                }
            }

            if (childAnalyses.length > 0) {
                await this.analyzeParent(currentPath, childAnalyses);
            }
        } else {
            // Leaf Lesson
            await this.analyzeLesson(currentPath);
        }
    }

    async runPipeline(rootCoursePath) {
        console.log(`[Analyzer] Starting pipeline for ${rootCoursePath}`);
        await this.processTree(rootCoursePath);
        console.log(`[Analyzer] Pipeline completed.`);
    }
}

module.exports = GeminiAnalyzer;
