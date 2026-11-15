// 豆包 Seed Audio（火山引擎）文字转语音客户端。
//
// 用途：给房间的「让她发语音」链路提供 TTS，替代没有配置的 Breeze。
// 接口：POST https://openspeech.bytedance.com/api/v3/tts/create
// 约定：
// - 只做「文字 → 音频 Buffer」，不落盘、不发送；落盘/发送由 bridge 负责。
// - 鉴权走 X-Api-App-Id / X-Api-Access-Key，密钥只从 config 读，不写日志。
// - 返回里带 subtitle 回读，便于上层判断「念的是不是这句话」。

const DEFAULT_API_BASE = 'https://openspeech.bytedance.com/api/v3/tts/create';
const DEFAULT_RESOURCE = 'seed-audio-1.0';
const DEFAULT_MODEL = 'seed-audio-1.0';
const DEFAULT_PERSONA = '一个憨萌软糯的小女生，声音甜甜的、有点奶，十几岁的感觉';
const DEFAULT_TEMPLATE = '{persona}，在QQ上给好朋友发语音，语气轻快自然，只说引号里的这句话，一字不差：“{text}”';

export class VolcTtsError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = 'VolcTtsError';
    this.status = status;
  }
}

const norm = (s) => String(s ?? '').replace(/[\s，。！？、,.!?~…"'“”‘’]/g, '');

/** 解析 config.volcTts（或环境变量 VOLC_SPEECH_*），缺字段时用豆包默认值。 */
export function resolveVolcTtsConfig(raw = {}, env = process.env) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const appId = String(c.appId || env.VOLC_SPEECH_APP_ID || '').trim();
  const accessKey = String(c.accessKey || env.VOLC_SPEECH_ACCESS_TOKEN || '').trim();
  return {
    configured: Boolean(c.enabled !== false && appId && accessKey),
    appId,
    accessKey,
    apiBase: String(c.apiBase || DEFAULT_API_BASE),
    resourceId: String(c.resourceId || DEFAULT_RESOURCE),
    model: String(c.model || DEFAULT_MODEL),
    persona: String(c.persona || DEFAULT_PERSONA),
    template: String(c.template || DEFAULT_TEMPLATE),
    format: String(c.format || 'mp3'),
    sampleRate: Math.max(8000, Math.round(Number(c.sampleRate) || 24000)),
    maxChars: Math.max(1, Math.round(Number(c.maxChars) || 120)),
    maxAttempts: Math.max(1, Math.round(Number(c.maxAttempts) || 2)),
    timeoutMs: Math.max(5000, Math.round(Number(c.timeoutMs) || 60000))
  };
}

function buildPrompt(cfg, text) {
  return cfg.template.replaceAll('{persona}', cfg.persona).replaceAll('{text}', text);
}

/**
 * 合成一段语音。
 * @returns {Promise<{buffer: Buffer, duration: number, heard: string, format: string}>}
 */
export async function synthesizeVolcSpeech(text, cfg, { signal } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new VolcTtsError('要说的话是空的');
  if (!cfg?.appId || !cfg?.accessKey) throw new VolcTtsError('缺少豆包语音的 appId / accessKey');
  if (clean.length > cfg.maxChars) {
    throw new VolcTtsError(`这条太长（${clean.length} 字），语音最多 ${cfg.maxChars} 字`);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
    const body = {
      model: cfg.model,
      text_prompt: buildPrompt(cfg, clean),
      audio_config: {
        format: cfg.format,
        sample_rate: cfg.sampleRate,
        enable_subtitle: true
      }
    };
    let response;
    try {
      response = await fetch(cfg.apiBase, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Api-App-Id': cfg.appId,
          'X-Api-Access-Key': cfg.accessKey,
          'X-Api-Resource-Id': cfg.resourceId,
          'X-Api-Request-Id': crypto.randomUUID()
        },
        body: JSON.stringify(body),
        signal: signal || AbortSignal.timeout(cfg.timeoutMs)
      });
    } catch (error) {
      lastError = new VolcTtsError(`豆包语音请求失败：${error?.message ?? error}`);
      continue;
    }

    const raw = await response.text();
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {
      throw new VolcTtsError(`豆包语音返回非 JSON（HTTP ${response.status}）：${raw.slice(0, 160)}`, { status: response.status });
    }
    if (!response.ok || !data.audio) {
      const brief = Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'audio'));
      throw new VolcTtsError(`豆包语音 HTTP ${response.status}：${JSON.stringify(brief).slice(0, 240)}`, { status: response.status });
    }

    const subtitle = data.subtitle || {};
    const heard = subtitle.text || (subtitle.sentences || []).map((s) => s.text || '').join('') || '';
    const duration = Number(data.original_duration || data.duration || 0);
    // 台词不一致（模型自由发挥）就重试一次，避免发出念错内容的语音
    if (heard && norm(heard) !== norm(clean)) {
      lastError = new VolcTtsError(`念成了「${heard.slice(0, 60)}」`);
      continue;
    }
    return {
      buffer: Buffer.from(String(data.audio), 'base64'),
      duration,
      heard,
      format: cfg.format
    };
  }
  throw lastError || new VolcTtsError('豆包语音合成失败');
}
