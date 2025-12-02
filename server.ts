/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as types from '@google/genai';
import {GoogleGenAI, Modality} from '@google/genai';
import {Hono} from 'hono';
import {cors} from 'hono/cors';

const GOOGLE_API_KEY = Deno.env.get('GOOGLE_API_KEY');

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
    const html = await Deno.readTextFile('./index.html');
    return c.html(html);
  });

  const port = 8000;

  Deno.serve({
    port,
    handler: (req) => {
      // Handle WebSocket upgrade
      if (req.headers.get('upgrade') === 'websocket') {
        const {socket, response} = Deno.upgradeWebSocket(req);

        console.log('WebSocket client connected');
        clients.add(socket);

        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);

            if (message.type === 'contentUpdateText') {
              session.sendClientContent({turns: message.text, turnComplete: true});
            } else if (message.type === 'realtimeInput') {
              session.sendRealtimeInput({media: createBlob(message.audioData)});
            }
          } catch (error) {
            console.error('Error parsing WebSocket message:', error);
          }
        };

        socket.onclose = () => {
          console.log('WebSocket client disconnected');
          clients.delete(socket);
        };

        socket.onerror = (error) => {
          console.error('WebSocket error:', error);
          clients.delete(socket);
        };

        return response;
      }

      // Handle HTTP requests
      return app.fetch(req);
    },
  });

  console.log(`Server running on http://localhost:${port}`);
}

main();