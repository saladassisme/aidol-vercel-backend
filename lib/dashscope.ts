import { requiredEnv, optionalEnv } from './env';
import { dashscopeFetch, dashscopeDownload } from './dashscopeFetch';
import { dashscopeEndpointBase } from './dashscopeRegion';

export { dashscopeEndpointBase, dashscopeRegion } from './dashscopeRegion';

function normalizeURL(url: string) {
  const trimmed = url.trim();
  return trimmed.startsWith('http://') ? `https://${trimmed.slice('http://'.length)}` : trimmed;
}

export async function cloneVoiceWithDashScope(params: {
  audioData: Buffer;
  mimeType: string;
  preferredName: string;
}) {
  const apiKey = requiredEnv('DASHSCOPE_API_KEY');
  const targetModel = optionalEnv('DASHSCOPE_TTS_VC_MODEL', 'qwen3-tts-vc-2026-01-22');
  const base64 = params.audioData.toString('base64');
  const dataURI = `data:${params.mimeType || 'audio/wav'};base64,${base64}`;

  const response = await dashscopeFetch(`${dashscopeEndpointBase()}/api/v1/services/audio/tts/customization`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'qwen-voice-enrollment',
      input: {
        action: 'create',
        target_model: targetModel,
        preferred_name: params.preferredName.slice(0, 32) || 'aidol_voice',
        audio: { data: dataURI }
      }
    })
  }, 'voice.clone');

  const text = await response.text();
  if (!response.ok) throw new Error(`DashScope clone failed: HTTP ${response.status} ${text}`);
  const json = JSON.parse(text);
  const voiceId = json.output?.voice ?? json.output?.voice_id ?? json.voice;
  if (!voiceId) throw new Error(`DashScope clone succeeded but no voice id was returned: ${text}`);
  return { voiceId: String(voiceId), provider: 'dashscope', model: targetModel, raw: json };
}

export async function synthesizeWithDashScope(params: {
  text: string;
  voiceId: string;
  model?: string;
  languageType?: string;
}) {
  const apiKey = requiredEnv('DASHSCOPE_API_KEY');
  const model = params.model || optionalEnv('DASHSCOPE_TTS_VC_MODEL', 'qwen3-tts-vc-2026-01-22');
  const languageType = params.languageType || 'Korean';

  const response = await dashscopeFetch(`${dashscopeEndpointBase()}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: {
        text: params.text,
        voice: params.voiceId,
        language_type: languageType
      }
    })
  }, 'tts.synthesize');

  const text = await response.text();
  if (!response.ok) throw new Error(`DashScope synthesize failed: HTTP ${response.status} ${text}`);
  const json = JSON.parse(text);
  const audioURL = json.output?.audio?.url ?? json.output?.audio_url ?? json.audio_url;
  if (!audioURL) throw new Error(`DashScope synthesize succeeded but no audio URL was returned: ${text}`);
  return { audioURL: normalizeURL(String(audioURL)), raw: json };
}

export async function downloadDashScopeAudio(audioURL: string) {
  const response = await dashscopeDownload(audioURL, 'tts.audio-download');
  if (!response.ok) {
    throw new Error(`音频下载失败：HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  if (!bytes.length) {
    throw new Error('音频下载失败：空文件');
  }
  return { audioBase64: bytes.toString('base64') };
}
