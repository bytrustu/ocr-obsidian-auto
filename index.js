import 'dotenv/config';
import chokidar from 'chokidar';
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';
import axios from 'axios';
import FormData from 'form-data';
import OpenAI from 'openai';
import { getGptPrompt } from './src/prompts.js';

const {
    CLOVA_API_URL,
    CLOVA_SECRET_KEY,
    OPENAI_API_KEY,
    OBSIDIAN_VAULT_PATH
} = process.env;
const WATCH_FOLDER = process.env.WATCH_FOLDER || OBSIDIAN_VAULT_PATH;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------

/**
 * 문자열 끝에 JPEG/PNG 등 확장자가 있다면 제거
 * ex) trimExtension("파일.jpeg") -> "파일"
 */
const trimImageExtension = (filename) =>
    filename.replace(/\.(jpg|jpeg|png|gif|bmp|webp)$/i, "");

/**
 * 파일명에서 공백, 특수문자를 밑줄(_)로 치환
 */
const sanitizeFilename = (filename) =>
    filename.replace(/[\\\/\?\*\:\|\"<>\s]/g, "_");

/**
 * JSON.parse() 헬퍼: 실패 시 fallback 반환
 */
const safeJsonParse = (str, fallback = {}) => {
    try {
        return JSON.parse(str);
    } catch {
        return fallback;
    }
};

// ------------------------------------------------------
// 1) 이미지 최적화
// ------------------------------------------------------
/**
 * 주어진 이미지 파일을 최적화(리사이즈, 포맷변환) 후 Buffer 반환
 */
const optimizeImage = async (imagePath) => {
    const imageBuffer = await fs.readFile(imagePath);
    const metadata = await sharp(imageBuffer).metadata();

    let optimized = sharp(imageBuffer);

    if (metadata.width > 1920 || metadata.height > 1080) {
        optimized = optimized.resize(1920, 1080, {
            fit: 'inside',
            withoutEnlargement: true
        });
    }

    switch ((metadata.format || '').toLowerCase()) {
        case 'jpeg':
        case 'jpg':
            optimized = optimized.jpeg({ quality: 80 });
            break;
        case 'png':
            optimized = optimized.png({ compressionLevel: 9 });
            break;
        default:
            optimized = optimized.jpeg({ quality: 80 });
            break;
    }

    return optimized.toBuffer();
};

// ------------------------------------------------------
// 2) Clova OCR
// ------------------------------------------------------
/**
 * Clova OCR 호출 → JSON 결과
 */
const callClovaOcr = async (imageBuffer) => {
    const formData = new FormData();
    const message = {
        version: "V2",
        requestId: String(Date.now()),
        timestamp: Date.now(),
        images: [
            { format: "png", name: "demo" }
        ]
    };

    formData.append('message', JSON.stringify(message));
    formData.append('file', imageBuffer, 'image.png');

    const response = await axios.post(CLOVA_API_URL, formData, {
        headers: {
            ...formData.getHeaders(),
            'X-OCR-SECRET': CLOVA_SECRET_KEY
        }
    });
    return response.data;
};

// ------------------------------------------------------
// 3) 경로 → 최대 3뎁스 폴더 추출
// ------------------------------------------------------
/**
 * Obsidian Vault 기준 상대 경로에서
 * 상위 폴더 3단계까지만 추출
 */
const getRawCategoryPath = (imagePath) => {
    const relPath = path.relative(OBSIDIAN_VAULT_PATH, imagePath);
    let parts = relPath.split(path.sep);
    parts.pop();
    parts = parts.filter((dir) => !dir.startsWith('_'));

    if (parts.length > 3) {
        parts = parts.slice(parts.length - 3);
    }

    return parts.join('/');
};

// ------------------------------------------------------
// 4) singleGptCall
//    한 번의 GPT 요청에서 improvedText, oneLineSummary, newFileName, categoryTag
//    를 JSON으로 반환
// ------------------------------------------------------

/**
 * 한 번의 GPT 호출로 여러 결과(마크다운 정리, 요약, 파일명, 태그)를 JSON으로 받음
 */
const singleGptCall = async ({
                                 ocrTexts, noteTitle, oldFileName, categoryPath
                             }) => {
    try {
        console.log('ocrTexts:', ocrTexts);
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            // gpt-4로 변경 가능
            messages: [
                { role: "system", content: "JSON으로 여러 작업을 처리하는 전문가입니다." },
                { role: "user", content: getGptPrompt({ ocrTexts, noteTitle, oldFileName, categoryPath }) },
            ],
            temperature: 0.3
        });

        const rawContent = response.choices[0].message.content.trim();
        const parsed = safeJsonParse(rawContent, {
            improvedText: "",
            oneLineSummary: "",
            newFileName: "",
            categoryTag: ""
        });

        return parsed;
    } catch (error) {
        console.error('[ERROR] singleGptCall 실패:', error);
        return {
            improvedText: "",
            oneLineSummary: "",
            newFileName: "",
            categoryTag: ""
        };
    }
};

// ------------------------------------------------------
// 5) 노트 검색 + 삽입
// ------------------------------------------------------
/**
 * Vault 내 .md 파일 목록
 */
const getAllMarkdownFiles = async (dir) => {
    const results = [];
    const list = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of list) {
        const filePath = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
            const subResults = await getAllMarkdownFiles(filePath);
            results.push(...subResults);
        } else if (dirent.isFile() && path.extname(dirent.name).toLowerCase() === '.md') {
            results.push(filePath);
        }
    }
    return results;
};

/**
 * "![[fileName]]" 부분을 찾은 다음 줄에 hiddenBlock 삽입
 */
const insertOcrToNoteIfReferenceFound = async (notePath, fileName, hiddenBlock) => {
    // 노트 전체 내용을 읽어옴
    let content = await fs.readFile(notePath, 'utf8');

    // [[_resources/이력서를 작성해요/파일명|Open: ...]] 형식의 링크가 있으면 제거함
    // fileName 변수에 해당하는 부분을 포함하고, '|Open:'이 들어있는 링크를 찾음
    const removalRegex = new RegExp(`\\[\\[([^\\]]*${fileName}[^\\]]*\\|Open:[^\\]]*)\\]\\]`, 'i');
    content = content.replace(removalRegex, '');

    // 줄 단위로 분리
    const lines = content.split(/\r?\n/);
    // ![[...]] 형식의 이미지 참조를 찾기 위한 정규식
    const wikilinkRegex = new RegExp(`!\\[\\[([^\\]]*${fileName}[^\\]]*)\\]\\]`, 'i');

    let changed = false;
    for (let i = 0; i < lines.length; i++) {
        if (wikilinkRegex.test(lines[i])) {
            // 이미지 참조 바로 다음 줄에 hiddenBlock 삽입
            lines.splice(i + 1, 0, hiddenBlock);
            changed = true;
            i++; // 삽입 후 인덱스 조정
        }
    }

    if (changed) {
        await fs.writeFile(notePath, lines.join('\n'), 'utf8');
    }
    return changed;
};

const insertOcrIntoExistingNotes = async (imagePath, hiddenBlock) => {
    const fileName = path.basename(imagePath);
    const mdFiles = await getAllMarkdownFiles(OBSIDIAN_VAULT_PATH);

    let matchCount = 0;
    for await (const mdFilePath of mdFiles) {
        const changed = await insertOcrToNoteIfReferenceFound(mdFilePath, fileName, hiddenBlock);
        if (changed) matchCount++;
    }

    console.log(`[INFO] "${fileName}" 이미지를 참조하는 노트에 OCR 텍스트 삽입 완료. (노트 수: ${matchCount})`);
};

/**
 * 특정 파일명을 ![[...]]로 참조하는 .md 목록
 */
const findNotesThatReferenceImage = async (fileName) => {
    const mdFiles = await getAllMarkdownFiles(OBSIDIAN_VAULT_PATH);
    const results = [];

    const wikilinkRegex = new RegExp(`!\\[\\[([^\\]]*${fileName}[^\\]]*)\\]\\]`, 'i');
    for await (const notePath of mdFiles) {
        const content = await fs.readFile(notePath, 'utf8');
        if (wikilinkRegex.test(content)) {
            results.push(notePath);
        }
    }

    return results;
};

// ------------------------------------------------------
// 6) 노트 링크 old->new 치환
// ------------------------------------------------------
const updateImageReferenceInNotes = async (notePaths, oldFileName, newFileName) => {
    for await (const notePath of notePaths) {
        const content = await fs.readFile(notePath, 'utf8');
        const replaced = content.replace(new RegExp(oldFileName, 'gi'), newFileName);
        if (replaced !== content) {
            await fs.writeFile(notePath, replaced, 'utf8');
            console.log(`[INFO] 노트 링크 갱신: ${path.basename(notePath)} (${oldFileName} -> ${newFileName})`);
        }
    }
};

// ------------------------------------------------------
// 7) 메인 로직
// ------------------------------------------------------
/**
 * MD5 이미지를 처리:
 * 1) 최적화
 * 2) OCR
 * 3) 한 번에 GPT 호출로 (improvedText, oneLineSummary, newFileName, categoryTag)
 * 4) 파일명 변경
 * 5) 숨김 블록 생성 → 노트 삽입
 */
const processImage = async (imagePath) => {
    try {
        console.log('[INFO] 새 MD5 이미지 처리 시작:', imagePath);

        // 1) 최적화
        const optimizedBuffer = await optimizeImage(imagePath);

        // 2) OCR
        // 2) OCR - 좌표 포함하여 텍스트 그룹핑하기
        const ocrResult = await callClovaOcr(optimizedBuffer);
        const fields = ocrResult?.images?.[0]?.fields || [];

        let grouped = [];
        let currentLine = [];

        fields.forEach((field) => {
            currentLine.push(field);
            if (field.lineBreak) {
                // 현재 라인의 모든 텍스트를 결합
                const lineText = currentLine.map((f) => f.inferText).join(' ');
                // 각 필드의 boundingPoly에서 최소 y값을 해당 라인의 y 좌표로 사용
                const lineY = Math.min(
                    ...currentLine.map((f) =>
                        Math.min(...(f.boundingPoly?.vertices?.map((v) => v.y) || [Infinity]))
                    )
                );
                grouped.push({ text: lineText, y: lineY });
                currentLine = [];
            }
        });

        // 남은 필드가 있다면 한 라인으로 추가
        if (currentLine.length > 0) {
            const lineText = currentLine.map((f) => f.inferText).join(' ');
            const lineY = Math.min(
                ...currentLine.map((f) =>
                    Math.min(...(f.boundingPoly?.vertices?.map((v) => v.y) || [Infinity]))
                )
            );
            const lineX = Math.min(
                ...currentLine.map((f) =>
                    Math.min(...(f.boundingPoly?.vertices?.map((v) => v.x) || [Infinity]))
                )
            );
            grouped.push({ text: lineText, x: lineX, y: lineY });
        }

        // 최종적으로 JSON 문자열로 변환 (예: { "texts": [ { "text": "...", "y": 74 }, ... ] })
        const allTexts = JSON.stringify({ texts: grouped });

        // 3) 노트 참조
        const oldFileName = path.basename(imagePath);
        const referencingNotes = await findNotesThatReferenceImage(oldFileName);

        let noteTitle = '';
        if (referencingNotes.length > 0) {
            noteTitle = path.basename(referencingNotes[0], '.md');
        }

        // 4) 폴더 경로 → 3뎁스 category
        const categoryPath = getRawCategoryPath(imagePath);

        // 5) GPT 한 번에 호출
        const gptResult = await singleGptCall({
            ocrTexts: allTexts,
            noteTitle,
            oldFileName,
            categoryPath
        });
        const { improvedText, oneLineSummary, newFileName, categoryTag } = gptResult;
        console.log('[DEBUG] GPT 결과:', gptResult);

        // // 6) 파일명 변경
        // let finalFileName = oldFileName;
        // let newFilePath = imagePath;
        // if (newFileName) {
        //     const ext = path.extname(oldFileName) || '.jpeg';
        //     const dirOfImage = path.dirname(imagePath);
        //     let sanitized = trimImageExtension(newFileName);
        //     sanitized = sanitizeFilename(sanitized);
        //     if (sanitized.length > 50) {
        //         sanitized = sanitized.slice(0, 50);
        //     }
        //     finalFileName = `${sanitized}${ext}`;
        //     newFilePath = path.join(dirOfImage, finalFileName);
        //
        //     try {
        //         await fs.rename(imagePath, newFilePath);
        //         console.log(`[INFO] 파일명 변경: "${oldFileName}" -> "${finalFileName}"`);
        //         await updateImageReferenceInNotes(referencingNotes, oldFileName, finalFileName);
        //     } catch (renameErr) {
        //         console.error('[ERROR] 파일명 변경 실패:', renameErr);
        //         newFilePath = imagePath;
        //         finalFileName = oldFileName;
        //     }
        // }

        // 7) 숨김 블록
        const now = new Date().toISOString().replace('T', ' ').split('.')[0];
        const finalTagLine = categoryTag ? `**태그:** ${categoryTag}` : '';
        const hiddenBlock = `
%%
**등록 일자:** ${now}
${finalTagLine}
**한줄 요약:** ${oneLineSummary}

**내용:**
${improvedText}
%%
`.trim();

        // 8) 노트 삽입
        await insertOcrIntoExistingNotes(imagePath, hiddenBlock);

        console.log('[INFO] 이미지 처리 완료:', imagePath);
    } catch (error) {
        console.error('[ERROR] 이미지 처리 실패:', imagePath, error);
    }
};

// ------------------------------------------------------
// 8) 메인 실행 (Chokidar 감시)
// ------------------------------------------------------
const main = async () => {
    console.log('[START] 실행');

    if (!CLOVA_API_URL || !CLOVA_SECRET_KEY || !OPENAI_API_KEY || !OBSIDIAN_VAULT_PATH) {
        console.error('[ERROR] 필수 ENV(CLOVA_API_URL 등)가 설정 안 됨');
        process.exit(1);
    }

    const validImageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    const watcher = chokidar.watch(WATCH_FOLDER, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 2000,
            pollInterval: 100
        }
    });

    watcher.on('add', async (filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        if (!validImageExts.includes(ext)) return;

        if (!filePath.includes('_MD5')) {
            return;
        }

        console.log('[INFO] 새 이미지 감지:', filePath);
        await processImage(filePath);
    });

    console.log(`[INFO] 이미지 감시 시작: ${WATCH_FOLDER}`);
};

process.on('uncaughtException', (err) => {
    console.error('[FATAL] 처리되지 않은 예외:', err);
    process.exit(1);
});
process.on('unhandledRejection', (err) => {
    console.error('[FATAL] 처리되지 않은 Promise 거부:', err);
    process.exit(1);
});

main().catch((err) => {
    console.error('[ERROR] 메인 프로세스 오류:', err);
    process.exit(1);
});
