// To run this code you need to install the following dependencies:
// npm install @google/genai mime fluent-ffmpeg
// npm install -D @types/node @types/fluent-ffmpeg
// You also need ffmpeg installed on your system

import {
  GoogleGenAI,
} from '@google/genai';
import 'dotenv/config';
import mime from 'mime';
import { writeFile, unlinkSync } from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStaticPath from 'ffmpeg-static';

const FFMPEG_PATH_ENV = process.env['FFMPEG_PATH'];
const resolvedFfmpegPath = FFMPEG_PATH_ENV || ffmpegStaticPath || '';

if (resolvedFfmpegPath) {
  ffmpeg.setFfmpegPath(resolvedFfmpegPath);
}

function saveBinaryFile(fileName: string, content: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    writeFile(fileName, content, (err) => {
      if (err) {
        console.error(`Error writing file ${fileName}:`, err);
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function convertToOpus(inputFile: string, outputFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!resolvedFfmpegPath) {
      reject(new Error('Cannot find ffmpeg. Install ffmpeg or set FFMPEG_PATH.'));
      return;
    }
    ffmpeg(inputFile)
      .audioCodec('libopus')
      .audioBitrate('64k')
      .output(outputFile)
      .on('end', () => {
        console.log(`File ${outputFile} saved to file system.`);
        // Delete temporary wav file
        try {
          unlinkSync(inputFile);
        } catch (e) {
          // Ignore cleanup errors
        }
        resolve();
      })
      .on('error', (err) => {
        console.error(`Error converting to opus:`, err);
        reject(err);
      })
      .run();
  });
}

const DEFAULT_TONE = 'happy';

function buildPrompt(content: string, tone?: string) {
  const resolvedTone = (tone && tone.trim()) ? tone.trim() : DEFAULT_TONE;
  return `Read ${resolvedTone} tone, talk in spanish:\n${content}`;
}

function getArgs() {
  const [, , contentArg, toneArg] = process.argv;
  if (!contentArg || !contentArg.trim()) {
    throw new Error('Missing content argument. Usage: npm run start -- "<content>" "<tone?>"');
  }

  return {
    content: contentArg.trim(),
    tone: toneArg?.trim(),
  };
}

async function main() {
  const { content, tone } = getArgs();
  const apiKey = process.env['GEMINI_API_KEY'];
  
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY. Check your .env file.');
  }

  const ai = new GoogleGenAI({
    apiKey,
  });
  const config = {
    temperature: 1,
    responseModalities: [
        'audio',
    ],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: 'Zephyr',
        }
      }
    },
  };
  const model = 'gemini-2.5-flash-preview-tts';
  const contents = [
    {
      role: 'user',
      parts: [
        {
          text: buildPrompt(content, tone),
        },
      ],
    },
  ];

  const response = await ai.models.generateContent({
    model,
    config,
    contents,
  });
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.inlineData) {
      const inlineData = part.inlineData;
      let fileExtension = mime.getExtension(inlineData.mimeType || '');
      let buffer = Buffer.from(inlineData.data || '', 'base64');
      if (!fileExtension) {
        fileExtension = 'wav';
        buffer = convertToWav(inlineData.data || '', inlineData.mimeType || '');
      }
      
      // Save as temp wav and convert to opus
      const tempWav = 'temp_output.wav';
      await saveBinaryFile(tempWav, buffer);
      await convertToOpus(tempWav, 'output.opus');
    } else if (part.text) {
      console.log(part.text);
    }
  }
}

main();

interface WavConversionOptions {
  numChannels : number,
  sampleRate: number,
  bitsPerSample: number
}

function convertToWav(rawData: string, mimeType: string) {
  const options = parseMimeType(mimeType)
  const buffer = Buffer.from(rawData, 'base64');
  const wavHeader = createWavHeader(buffer.length, options);

  return Buffer.concat([wavHeader, buffer]);
}

function parseMimeType(mimeType : string) {
  const [fileType, ...params] = mimeType.split(';').map(s => s.trim());
  const [_, format] = fileType.split('/');

  const options : Partial<WavConversionOptions> = {
    numChannels: 1,
    sampleRate: 16000,
    bitsPerSample: 16,
  };

  if (format && format.startsWith('L')) {
    const bits = parseInt(format.slice(1), 10);
    if (!isNaN(bits)) {
      options.bitsPerSample = bits;
    }
  }

  for (const param of params) {
    const [key, value] = param.split('=').map(s => s.trim());
    if (key === 'rate') {
      options.sampleRate = parseInt(value, 10);
    }
  }

  return options as WavConversionOptions;
}

function createWavHeader(dataLength: number, options: WavConversionOptions) {
  const {
    numChannels,
    sampleRate,
    bitsPerSample,
  } = options;

  // http://soundfile.sapp.org/doc/WaveFormat

  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const buffer = Buffer.alloc(44);

  buffer.write('RIFF', 0);                      // ChunkID
  buffer.writeUInt32LE(36 + dataLength, 4);     // ChunkSize
  buffer.write('WAVE', 8);                      // Format
  buffer.write('fmt ', 12);                     // Subchunk1ID
  buffer.writeUInt32LE(16, 16);                 // Subchunk1Size (PCM)
  buffer.writeUInt16LE(1, 20);                  // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(numChannels, 22);        // NumChannels
  buffer.writeUInt32LE(sampleRate, 24);         // SampleRate
  buffer.writeUInt32LE(byteRate, 28);           // ByteRate
  buffer.writeUInt16LE(blockAlign, 32);         // BlockAlign
  buffer.writeUInt16LE(bitsPerSample, 34);      // BitsPerSample
  buffer.write('data', 36);                     // Subchunk2ID
  buffer.writeUInt32LE(dataLength, 40);         // Subchunk2Size

  return buffer;
}
