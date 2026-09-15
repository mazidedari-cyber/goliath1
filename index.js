import http from 'http';
import { Client, GatewayIntentBits } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType
} from '@discordjs/voice';
import prism from 'prism-media';
import pathToFfmpeg from 'ffmpeg-static';
import WebSocket from 'ws';
import { PassThrough } from 'stream';

// FFmpegのパスを prism-media に認識させる
process.env.FFMPEG_PATH = pathToFfmpeg;

// ==========================================
// 1. Render用 ダミーHTTPサーバー（スリープ・エラー防止）
// ==========================================
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Gemini Voice Bot is alive!\n');
}).listen(port, () => {
  console.log(`🌐 HTTP Server listening on port ${port}`);
});

// ==========================================
// 2. Discord クライアント設定
// ==========================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let geminiWs = null;
let audioPlayer = null;
let currentAudioStream = null;

client.once('ready', () => {
  console.log(`✅ ログイン成功: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // 参加コマンド: !join
  if (message.content === '!join') {
    const channel = message.member?.voice?.channel;
    if (!channel) {
      return message.reply('先にボイスチャンネルに入室してから `!join` してね！');
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    audioPlayer = createAudioPlayer();
    connection.subscribe(audioPlayer);

    // Gemini 3.1 Flash Live への WebSocket 接続を開始
    startGeminiSession(connection, message.author.id);
    message.reply('VCに参加したよ！話しかけてみてね。（割り込みもできるよ）');
  }

  // 退出コマンド: !leave
  if (message.content === '!leave') {
    if (geminiWs) {
      geminiWs.close();
      geminiWs = null;
    }
    if (audioPlayer) {
      audioPlayer.stop();
    }
    const connection = joinVoiceChannel({
      channelId: message.member?.voice?.channel?.id || '',
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
    });
    connection?.destroy();
    message.reply('バイバイ！');
  }
});

// ==========================================
// 3. Gemini 3.1 Flash Live セッション管理
// ==========================================
function startGeminiSession(connection, targetUserId) {
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
  geminiWs = new WebSocket(url);

  geminiWs.on('open', () => {
    console.log('🔗 Gemini Live API に接続成功');

    // 初期セットアップメッセージの送信
    const setupMsg = {
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Aoede" // 落ち着いた自然な女性声
              }
            }
          }
        },
        systemInstruction: {
          parts: [{ text: "あなたはDiscordでフレンドリーに通話するAIです。短めの相槌やテンポのいい日本語で会話してください。" }]
        }
      }
    };
    geminiWs.send(JSON.stringify(setupMsg));

    // ユーザー音声の録音 & 送信パイプライン開始
    startListeningToUser(connection.receiver, targetUserId);
  });

  // Gemini から音声を受信
  geminiWs.on('message', (data) => {
    const response = JSON.parse(data.toString());

    // ユーザーが割り込んだ（Barge-in）場合
    if (response.serverContent?.interrupted) {
      console.log('⚡ 割り込み検知: Botの発話を中断');
      if (audioPlayer) audioPlayer.stop();
      if (currentAudioStream) {
        currentAudioStream.destroy();
        currentAudioStream = null;
      }
      return;
    }

    // AIの音声データを受信
    const parts = response.serverContent?.modelTurn?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          const rawPcm = Buffer.from(part.inlineData.data, 'base64');
          playAudioToDiscord(rawPcm);
        }
      }
    }
  });

  geminiWs.on('error', (err) => console.error('Gemini WS エラー:', err));
  geminiWs.on('close', () => console.log('Gemini WS 接続終了'));
}

// ユーザーの音声を 16kHz モノラル PCM に変換して Gemini に送信
function startListeningToUser(receiver, userId) {
  const opusStream = receiver.subscribe(userId);
  const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

  const downsampler = new prism.FFmpeg({
    args: [
      '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', '-',
      '-f', 's16le', '-ar', '16000', '-ac', '1',
      '-flush_packets', '1', '-'
    ]
  });

  opusStream.pipe(opusDecoder).pipe(downsampler);

  downsampler.on('data', (chunk) => {
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{
            mimeType: "audio/pcm;rate=16000",
            data: chunk.toString('base64')
          }]
        }
      }));
    }
  });
}

// Geminiの音声 (24kHz Mono) ➔ 48kHz Stereo PCM に変換して Discord で再生
function playAudioToDiscord(pcmBuffer) {
  if (!currentAudioStream || currentAudioStream.destroyed) {
    currentAudioStream = new PassThrough();

    const upsampler = new prism.FFmpeg({
      args: [
        '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', '-',
        '-f', 's16le', '-ar', '48000', '-ac', '2',
        '-flush_packets', '1', '-'
      ]
    });

    currentAudioStream.pipe(upsampler);

    const resource = createAudioResource(upsampler, {
      inputType: StreamType.Raw
    });

    audioPlayer.play(resource);
  }

  currentAudioStream.write(pcmBuffer);
}

// ログイン実行
client.login(process.env.DISCORD_TOKEN);
