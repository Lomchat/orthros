import * as fs from 'fs';
import * as path from 'path';

const MAX_LINES = 1000;
const MODULES_DIR = path.join(process.cwd(), 'src/worker/modules');

function checkDirectory(dir: string) {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stats = fs.statSync(fullPath);
        
        if (stats.isDirectory()) {
            checkDirectory(fullPath);
        } else if (file.endsWith('.ts') && file !== 'index.ts') {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n').length;
            
            if (lines > MAX_LINES) {
                console.error(`\x1b[31mError: File ${fullPath} exceeds line limit (${lines} > ${MAX_LINES})\x1b[0m`);
                process.exit(1);
            } else if (lines > MAX_LINES * 0.8) {
                console.warn(`\x1b[33mWarning: File ${fullPath} is approaching line limit (${lines}/${MAX_LINES})\x1b[0m`);
            }
        }
    }
}

console.log('Checking file sizes in src/worker/modules...');
try {
    checkDirectory(MODULES_DIR);
    console.log('\x1b[32mAll files within size limits.\x1b[0m');
} catch (error) {
    console.error('Error checking file sizes:', error);
    process.exit(1);
}
