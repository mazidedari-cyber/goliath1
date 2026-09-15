import http from 'http';
import { Readable, PassThrough } from 'stream';
import { Client, GatewayIntentBits } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  EndBehaviorType,
} from '@discordjs/voice';
import prism from 'prism-media';
import WebSocket from 'ws';

// ==========================================
// 1. Render用 ダミーHTTPサーバー
// ==========================================
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Gemini Voice Bot is running!\n');
}).listen(port, () => {
  console.log(`🌐 HTTP Server listening on port ${port}`);
});

// ==========================================
// 2. 超高速・低遅延リサンプリング関数（純JS実装）
// ==========================================
// 48kHz Stereo (Discord) ➔ 16kHz Mono (Gemini) : 3分の1に間引き & モノラル化
function downsample48kStereoTo16kMono(buffer) {
  const outSamples = Math.floor(buffer.length / 12); // 1サンプルあたり4バイト(左右2ch) * 3サンプル = 12バイト
  const outBuffer = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const inOffset = i * 12;
    const left = buffer.readInt16LE(inOffset);
    const right = buffer.readInt16LE(inOffset + 2);
    const mono = Math.round((left + right) / 2);
    outBuffer.writeInt16LE(mono, i * 2);
  }
  return outBuffer;
}

// 24kHz Mono (Gemini) ➔ 48kHz Stereo (Discord) : 2倍補間 & ステレオ複製
function upsample24kMonoTo48kStereo(buffer) {
  const inSamples = Math.floor(buffer.length / 2);
  const outBuffer = Buffer.alloc(inSamples * 8); // 24k->48k(2倍) * 2ch(2倍) * 2byte = 8倍
  let outOffset = 0;
  for (let i = 0; i < inSamples; i++) {
    const sample = buffer.readInt16LE(i * 2);
    // 時刻 t: Left, Right
    outBuffer.writeInt16LE(sample, outOffset);
    outBuffer.writeInt16LE(sample, outOffset + 2);
    // 時刻 t+1: Left, Right
    outBuffer.writeInt16LE(sample, outOffset + 4);
    outBuffer.writeInt16LE(sample, outOffset + 6);
    outOffset += 8;
  }
  return outBuffer;
}

// ==========================================
// 3. Discord クライアント設定
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
let playStream = null;

client.once('ready', () => {
  console.log(`✅ ログイン成功: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

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

    // 【対策1】無音Opusパケットを1度流してDiscordのUDP受信ロックを解除
    kickstartVoiceConnection(audioPlayer);

    // Geminiセッション開始
    startGeminiSession(connection, message.author.id);
    message.reply('接続しました！何か話しかけてみてね！');
  }

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

// 無音パケット送信（UDP handshake トリガー）
function kickstartVoiceConnection(player) {
  const silenceBuffer = Buffer.from([0xf8, 0xff, 0xfe]);
  const silenceStream = new Readable({
    read() {
      this.push(silenceBuffer);
      this.push(null);
    },
  });
  const resource = createAudioResource(silenceStream, { inputType: StreamType.Opus });
  player.play(resource);
}

// ==========================================
// 4. Gemini 3.1 Flash Live 連携
// ==========================================
function startGeminiSession(connection, targetUserId) {
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
  geminiWs = new WebSocket(url);

  geminiWs.on('open', () => {
    console.log('🔗 Gemini Live API に接続しました');

    // 初期セットアップ
    const setupMsg = {
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Aoede",
              },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: "あなたはDiscordで通話する友達AIです。日本語で自然に、短めの相槌やテンポのいい言葉で会話してください。" }],
        },
      },
    };
    geminiWs.send(JSON.stringify(setupMsg));

    // 音声受信パイプラインを開始
    startListeningToUser(connection.receiver, targetUserId);
  });

  geminiWs.on('message', (data) => {
    const response = JSON.parse(data.toString());

    // セットアップ完了通知
    if (response.setupComplete) {
      console.log('🤖 Gemini の準備が整いました！対話可能です。');
      return;
    }

    // 割り込み検知 (Barge-in)
    if (response.serverContent?.interrupted) {
      console.log('⚡ 割り込みを検知: Botの発話を即座に停止');
      if (audioPlayer) audioPlayer.stop();
      if (playStream) {
        playStream.destroy();
        playStream = null;
      }
      return;
    }

    // Geminiからの音声データを受信して再生
    const parts = response.serverContent?.modelTurn?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          const rawPcm24k = Buffer.from(part.inlineData.data, 'base64');
          playAudioToDiscord(rawPcm24k);
        }
      }
    }
  });

  geminiWs.on('error', (err) => console.error('❌ Gemini WS エラー:', err));
  geminiWs.on('close', (code, reason) => {
    console.log(`🔌 Gemini WS 接続終了 (code: ${code}, reason: ${reason})`);
  });
}

// ユーザーの音声を受信して Gemini に送信
function startListeningToUser(receiver, userId) {
  // 【対策2】EndBehaviorType.Manual で無音になってもストリームを維持
  const opusStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.Manual,
    },
  });

  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  opusStream.pipe(decoder);

  let sendCount = 0;
  decoder.on('data', (pcm48kStereo) => {
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      const pcm16kMono = downsample48kStereoTo16kMono(pcm48kStereo);
      geminiWs.send(
        JSON.stringify({
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: 'audio/pcm;rate=16000',
                data: pcm16kMono.toString('base64'),
              },
            ],
          },
        })
      );

      sendCount++;
      if (sendCount % 50 === 0) {
        console.log('🎙️ あなたの音声を Gemini に送信中...');
      }
    }
  });

  decoder.on('error', (err) => console.error('デコーダーエラー:', err));
}

// Gemini の音声を Discord で再生
function playAudioToDiscord(pcm24kMono) {
  const pcm48kStereo = upsample24kMonoTo48kStereo(pcm24kMono);

  if (!playStream || playStream.destroyed) {
    playStream = new PassThrough();
    const resource = createAudioResource(playStream, {
      inputType: StreamType.Raw,
    });
    audioPlayer.play(resource);
  }

  playStream.write(pcm48kStereo);
}

client.login(process.env.DISCORD_TOKEN);
