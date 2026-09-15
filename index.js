import http from 'http';
import { Readable, PassThrough } from 'stream';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
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
  console.log(`🌐 [Render] HTTP Server listening on port ${port}`);
});

// ==========================================
// 2. 超高速リサンプリング関数
// ==========================================
// 48kHz Stereo ➔ 16kHz Mono
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

// 24kHz Mono ➔ 48kHz Stereo
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
// 3. Discord クライアント
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

client.once(Events.ClientReady, () => {
  console.log(`✅ [Discord] ログイン成功: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content === '!join') {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply('先にボイスチャンネルに入室してから `!join` してね！');
    }

    console.log(`🚪 [Discord] VC (${voiceChannel.name}) に接続中...`);

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    audioPlayer = createAudioPlayer();
    connection.subscribe(audioPlayer);

    try {
      // 【最重要】DiscordのVC接続が「Ready」になるのを確実に待つ（最大15秒）
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      console.log('🎉 [Discord] VC接続が Ready になりました！');

      // 通信トリガー用の無音パケット送信
      kickstartVoiceConnection(audioPlayer);

      // Gemini 接続 & 音声リスナー開始
      startGeminiSession(connection);
      message.reply('準備完了！VCで話しかけてみてね！');
    } catch (err) {
      console.error('❌ [Discord] VC接続エラー:', err);
      connection.destroy();
      message.reply('VC接続に失敗しました。もう一度試してください。');
    }
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
function startGeminiSession(connection) {
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
  geminiWs = new WebSocket(url);

  geminiWs.on('open', () => {
    console.log('🔗 [Gemini] WebSocket 接続開始');

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
          parts: [{ text: "あなたはDiscordでフレンドリーに通話するAI友達です。短めの相槌やテンポのいい日本語で楽しく会話してください。" }],
        },
      },
    };
    geminiWs.send(JSON.stringify(setupMsg));
    console.log('📤 [Gemini] セットアップメッセージを送信しました');

    // 話者検知のリスナー開始
    setupSpeakingListener(connection.receiver);
  });

  geminiWs.on('message', (data) => {
    const response = JSON.parse(data.toString());

    // エラー検知
    if (response.error) {
      console.error('❌ [Gemini API エラー]:', response.error);
      return;
    }

    // セットアップ完了
    if (response.setupComplete) {
      console.log('🤖 [Gemini] セットアップ完了！いつでも会話できます！');
      return;
    }

    // 割り込み検知 (Barge-in)
    if (response.serverContent?.interrupted) {
      console.log('⚡ [Gemini] 割り込みを検知: Botの発話を中断');
      if (audioPlayer) audioPlayer.stop();
      if (playStream) {
        playStream.destroy();
        playStream = null;
      }
      return;
    }

    // 音声データ受信
    const parts = response.serverContent?.modelTurn?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          const rawPcm24k = Buffer.from(part.inlineData.data, 'base64');
          playAudioToDiscord(rawPcm24k);
        }
      }
    }

    if (response.serverContent?.turnComplete) {
      console.log('✅ [Gemini] AIのターンが完了しました');
    }
  });

  geminiWs.on('error', (err) => console.error('❌ [Gemini WS エラー]:', err));
  geminiWs.on('close', (code, reason) => {
    console.log(`🔌 [Gemini WS 切断] code: ${code}, reason: ${reason}`);
  });
}

// ユーザーが喋り始めた時の処理
function setupSpeakingListener(receiver) {
  receiver.speaking.on('start', (userId) => {
    // Bot自身の声は無視する
    if (userId === client.user.id) return;

    console.log(`🎙️ [Discord] ユーザー(${userId}) の発話を検知しました！`);

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 300, // 300ms無音で区切る
      },
    });

    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    opusStream.pipe(decoder);

    let sentChunks = 0;
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
        sentChunks++;
      }
    });

    opusStream.on('end', () => {
      console.log(`🔇 [Discord] 発話終了 (Geminiへ送ったパケット数: ${sentChunks})`);
    });

    decoder.on('error', (err) => console.error('❌ デコーダーエラー:', err));
  });
}

// 音声をDiscord VCに流す
function playAudioToDiscord(pcm24kMono) {
  const pcm48kStereo = upsample24kMonoTo48kStereo(pcm24kMono);

  if (!playStream || playStream.destroyed || playStream.writableEnded) {
    playStream = new PassThrough();
    const resource = createAudioResource(playStream, {
      inputType: StreamType.Raw,
    });
    audioPlayer.play(resource);
    console.log('🔊 [Discord] AIが返答を再生中...');
  }

  playStream.write(pcm48kStereo);
}

client.login(process.env.DISCORD_TOKEN);
