import http from 'http';
import { Readable, PassThrough } from 'stream';
import { Client, GatewayIntentBits, Events } from 'discord.js';
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
// 2. 超高速リサンプリング関数
// ==========================================
// 48kHz Stereo (Discord) ➔ 16kHz Mono (Gemini)
function downsample48kStereoTo16kMono(buffer) {
  const outSamples = Math.floor(buffer.length / 12);
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

// 24kHz Mono (Gemini) ➔ 48kHz Stereo (Discord)
function upsample24kMonoTo48kStereo(buffer) {
  const inSamples = Math.floor(buffer.length / 2);
  const outBuffer = Buffer.alloc(inSamples * 8);
  let outOffset = 0;
  for (let i = 0; i < inSamples; i++) {
    const sample = buffer.readInt16LE(i * 2);
    outBuffer.writeInt16LE(sample, outOffset);
    outBuffer.writeInt16LE(sample, outOffset + 2);
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

// 警告対策: Events.ClientReady を使用
client.once(Events.ClientReady, () => {
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

    // UDPロック解除用の無音パケット送信
    kickstartVoiceConnection(audioPlayer);

    // Gemini 接続 & 音声検知リスナー開始
    startGeminiSession(connection, message.author.id);
    message.reply('接続しました！VCで話しかけてみてね！');
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
          parts: [{ text: "あなたはDiscordでフレンドリーに通話するAIです。日本語で自然に、短めの相槌やテンポのいい言葉で会話してください。" }],
        },
      },
    };
    geminiWs.send(JSON.stringify(setupMsg));

    // 【重要】ユーザーが喋り始めたイベントを監視
    setupSpeakingListener(connection.receiver, targetUserId);
  });

  geminiWs.on('message', (data) => {
    const response = JSON.parse(data.toString());

    if (response.setupComplete) {
      console.log('🤖 Gemini の準備が整いました！対話可能です。');
      return;
    }

    // 割り込み検知
    if (response.serverContent?.interrupted) {
      console.log('⚡ 割り込みを検知: Botの発話を即座に停止');
      if (audioPlayer) audioPlayer.stop();
      if (playStream) {
        playStream.destroy();
        playStream = null;
      }
      return;
    }

    // Geminiからの音声再生
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

// ユーザーが喋り始めた瞬間にストリームを購読する
function setupSpeakingListener(receiver, targetUserId) {
  receiver.speaking.on('start', (userId) => {
    if (userId !== targetUserId) return; // 対象ユーザーのみ

    console.log('🎙️ [Discord] あなたの声（発話）を検知しました！');

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 200, // 200ms無音で一旦区切る
      },
    });

    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    opusStream.pipe(decoder);

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
      }
    });

    opusStream.on('end', () => {
      console.log('🔇 [Discord] 発話が終了しました。Geminiの返答を待ちます。');
    });

    decoder.on('error', (err) => console.error('デコーダーエラー:', err));
  });
}

// 音声再生
function playAudioToDiscord(pcm24kMono) {
  const pcm48kStereo = upsample24kMonoTo48kStereo(pcm24kMono);

  if (!playStream || playStream.destroyed) {
    playStream = new PassThrough();
    const resource = createAudioResource(playStream, {
      inputType: StreamType.Raw,
    });
    audioPlayer.play(resource);
    console.log('🔊 [Discord] AIが返答を話し始めました！');
  }

  playStream.write(pcm48kStereo);
}

client.login(process.env.DISCORD_TOKEN);
