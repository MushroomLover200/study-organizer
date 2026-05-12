# Project Architecture and Guidelines

## Codebase Understanding

This project is a Node.js-based system designed to automatically synchronize, process, and analyze educational course materials from Blackboard (MCL) using the Gemini AI SDK.

### Directory Structure
*   **`server/`**: Contains the backend logic and synchronization engine.
    *   **`index.js`**: The main entry point. Validates system dependencies (`gdown`, `canva-dl`), triggers the Blackboard sync, and automatically kicks off the analysis pipeline upon completion.
    *   **`src/Session.js`**: Manages the Blackboard connection via `mcl-bbl-engine`. It tracks state (`.sync-state.json`), manages concurrent file downloads using semaphores, and constructs the local folder structure based on the academic term and course hierarchy.
    *   **`src/GeminiAnalyzer.js`**: The core AI formatting engine. It traverses the downloaded course folders from the bottom up. It uploads multimodal content (PDFs, videos, images) using the GenAI Files API, forces a structured "Content Block" JSON output from Gemini, and formats that JSON into highly grounded, readable `analysis.md` files for both individual lessons and parent modules. 
    *   **`src/utils.js`**: Provides utility tools like concurrency control (`Semaphore`) and path sanitization.
    *   **`analyzer-config.json`**: External configuration for the `GeminiAnalyzer` (model selection, temperature, token limits, system prompts).
*   **`data/`**: The local storage directory where synced materials and generated `analysis.md` / `analysis.json` files reside. The path structure generally follows: `data/{username}/{academicYear} {term}/{Course}/{Module}/{Lesson}/...`
*   **`frontend/`**: Reserved for future user-facing interfaces.

### Key Architectural Nuances
*   **Hierarchical Roll-up**: The analyzer processes "Leaf" folders (lessons) first, generating a granular study guide based on raw files. It then moves up the tree, synthesizing those child guides into Module overviews, and eventually Course overviews.
*   **`ultraDocumentBody` Flattening**: Blackboard sometimes stores lesson parts in subfolders named `ultraDocumentBody`. The analyzer treats the contents of a lesson folder and any `ultraDocumentBody` subdirectory within it as a single, flat collection of lesson materials.

---

## Available AI Models

We have access to the following verified models for use in this project:
- `gemini-2.5-flash`
- `gemini-2.5-pro`
- `gemini-2.0-flash-lite`
- `gemini-flash-latest`
- `gemini-flash-lite-latest`
- `gemini-pro-latest`
- `gemini-2.5-flash-lite`
- `gemini-3-flash-preview`
- `gemini-3.1-pro-preview`
- `gemini-3.1-flash-lite-preview`

---

## AI SDK Usage

*   **Mandatory SDK:** All interactions with Google Gemini models MUST use the new unified `@google/genai` SDK.
*   **Legacy SDK:** NEVER use the legacy `@google/generative-ai` SDK.

### Implementation Details (`@google/genai`)

The new SDK is a unified client for both Gemini Developer API (AI Studio) and Vertex AI.

#### 1. Initialization
```javascript
const { GoogleGenAI } = require('@google/genai');
// For standard AI Studio usage:
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
```

#### 2. Multimodal File Uploads & Polling (Crucial Nuance)
When passing non-text files (PDFs, MP4s, etc.), you must use the Files API. **Large files (especially videos) are not instantly available; you must poll for the `ACTIVE` state before passing them to `generateContent`.**
Also, ensure the `displayName` is sanitized of non-ASCII characters to prevent ByteString errors.

```javascript
// Upload the file
let file = await ai.files.upload({
    file: filePath,
    config: {
        mimeType: 'video/mp4',
        displayName: path.basename(filePath).replace(/[^\x00-\x7F]/g, '_'),
    }
});

// Poll until ACTIVE
while (file.state === 'PROCESSING') {
    await new Promise(resolve => setTimeout(resolve, 5000));
    file = await ai.files.get({ name: file.name });
}

if (file.state === 'FAILED') throw new Error('File processing failed');

// Cleanup remotely when done!
await ai.files.delete({ name: file.name }); 
```

#### 3. Basic Content Generation
Access models via the `.models` property. You can pass raw strings or complex part arrays.
```javascript
const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash', 
    contents: [
        {
            role: 'user',
            parts: [
                { text: 'Analyze this video:' },
                { fileData: { fileUri: file.uri, mimeType: file.mimeType } }
            ]
        }
    ],
    config: { temperature: 0.7 }
});
console.log(response.text);
```

#### 4. Structured Output (JSON Schema Nuances)
While the SDK claims to support Zod natively via `responseSchema`, deeply nested Zod schemas can occasionally trigger backend formatting errors (e.g., `Unknown name "_def"`). 
**Best Practice for Complex Schemas:** Use a plain JSON Schema object and assign it to the `responseJsonSchema` configuration property.

```javascript
const myJsonSchema = {
    type: 'object',
    properties: {
        recipeName: { type: 'string' },
        ingredients: { type: 'array', items: { type: 'string' } }
    },
    required: ['recipeName', 'ingredients']
};

const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: 'Give me a recipe for pancakes.',
    config: {
        responseMimeType: 'application/json',
        responseJsonSchema: myJsonSchema, // Use responseJsonSchema for plain objects
    }
});

// The SDK automatically parses the JSON text into a JS object on response.value
const data = response.value || JSON.parse(response.text);
console.log(data.recipeName); 
```

#### 5. System Instructions
System instructions are passed inside the `config` object.
```javascript
const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: 'Hello',
    config: {
        systemInstruction: 'You are a helpful pirate.'
    }
});
```
