import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`YouTube Shadowing server running on port ${PORT}`);
});
