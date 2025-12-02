import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { GoogleGenAI, Modality } from '@google/genai';
import * as types from '@google/genai';
import { WebSocketServer, WebSocket } from 'ws';
import { readFile } from 'fs/promises';
import dotenv from 'dotenv';

dotenv.config();

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

export function createBlob(audioData: string): types.Blob {
  return {data: audioData, mimeType: 'audio/pcm;rate=16000'};
}

export function debug(data: object): string {
  return JSON.stringify(data);
}

async function main() {
  const clients = new Set<WebSocket>();

  const options: types.GoogleGenAIOptions = {
    vertexai: false,
    apiKey: GOOGLE_API_KEY,
  };
  const model = 'gemini-live-2.5-flash-preview';

  const ai = new GoogleGenAI(options);
  const config: types.LiveConnectConfig = {
    responseModalities: [
        Modality.AUDIO,
    ],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: 'Zephyr',
        },
      },
    },
    tools: [
      { googleSearch: {} },
    ],
  };

  const session = await ai.live.connect({
    model: model,
    config,
    callbacks: {
      onopen: () => {
        console.log('Live Session Opened');
      },
      onmessage: (message: types.LiveServerMessage) => {
        console.log('Received message from the server: %s\n', debug(message));
        if (
          message.serverContent &&
          message.serverContent.modelTurn &&
          message.serverContent.modelTurn.parts &&
          message.serverContent.modelTurn.parts.length > 0 &&
          message.serverContent.modelTurn.parts[0].inlineData &&
          message.serverContent.modelTurn.parts[0].inlineData.data
        ) {
          // Broadcast to all connected WebSocket clients
          const audioData = message.serverContent.modelTurn.parts[0].inlineData.data;
          clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({type: 'audioStream', data: audioData}));
            }
          });
        }
      },
      onerror: (e: ErrorEvent) => {
        console.log('Live Session Error:', debug(e));
      },
      onclose: (e: CloseEvent) => {
        console.log('Live Session Closed:', debug(e));
      },
    },
  });

  const app = new Hono();

  app.use('/*', cors());

  app.get('/', async (c) => {
    const html = await readFile('./index.html', 'utf-8');
    return c.html(html);
  });

  const port = 8000;

  const server = serve({
    fetch: app.fetch,
    port,
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket) => {
    console.log('WebSocket client connected');
    clients.add(socket);

    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'contentUpdateText') {
          session.sendClientContent({turns: message.text, turnComplete: true});
        } else if (message.type === 'realtimeInput') {
          session.sendRealtimeInput({media: createBlob(message.audioData)});
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    });

    socket.on('close', () => {
      console.log('WebSocket client disconnected');
      clients.delete(socket);
    });

    socket.on('error', (error) => {
      console.error('WebSocket error:', error);
      clients.delete(socket);
    });
  });

  console.log(`Server running on http://localhost:${port}`);
}

main();