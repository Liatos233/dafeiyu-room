#!/usr/bin/env bash
# 把 livingmemory 的向量嵌入从「本机 Ollama」切到「硅基流动 bge-m3」
# 用法：bash set-embedding-siliconflow.sh <API_KEY> [模型名]
set -euo pipefail

KEY="${1:?用法: bash set-embedding-siliconflow.sh <硅基流动 API Key> [模型]}"
MODEL="${2:-BAAI/bge-m3}"
PROV_ID="bge-m3 (SiliconFlow)"
DATA=/root/data
BASE=https://api.siliconflow.cn/v1

echo "==> 校验 Key"
code=$(curl -s -o /tmp/sf.json -w "%{http_code}" -m 25 -X POST "$BASE/embeddings" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"input\":\"连通性测试\"}")
if [ "$code" != "200" ]; then
  echo "!! Key 校验失败 HTTP $code: $(head -c 200 /tmp/sf.json)" >&2
  exit 1
fi
python3 - <<'PY'
import json
d = json.load(open("/tmp/sf.json"))
dim = len(d["data"][0]["embedding"])
print(f"   Key OK，向量维度 = {dim}")
PY

echo "==> 备份配置"
cp "$DATA/cmd_config.json" "$DATA/cmd_config.json.bak-embed-$(date +%H%M)"
cp "$DATA/config/astrbot_plugin_livingmemory_config.json" "$DATA/config/astrbot_plugin_livingmemory_config.json.bak-embed" 2>/dev/null || true

echo "==> 写入 provider"
python3 - "$KEY" "$MODEL" "$BASE" <<'PY'
import json, sys
key, model, base = sys.argv[1], sys.argv[2], sys.argv[3]
p = "/root/data/cmd_config.json"
c = json.load(open(p, encoding="utf-8-sig"))

SRC_ID = "siliconflow-embedding"
PROV_ID = "bge-m3 (SiliconFlow)"

sources = c.setdefault("provider_sources", [])
sources = [s for s in sources if s.get("id") != SRC_ID]
sources.append({
    "provider": "siliconflow",
    "type": "openai_embedding",
    "provider_type": "embedding",
    "key": [key],
    "api_base": base,
    "timeout": 30,
    "proxy": "",
    "custom_headers": {},
    "id": SRC_ID,
    "enable": True,
})
c["provider_sources"] = sources

provs = c.setdefault("provider", [])
provs = [p for p in provs if p.get("id") != PROV_ID]
provs.append({
    "id": PROV_ID,
    "enable": True,
    "provider_source_id": SRC_ID,
    "model": model,
    "embedding_model": model,
    "embedding_api_base": base,
    "embedding_api_key": key,
    "embedding_dimensions": 1024,
    "modalities": ["embedding"],
    "max_context_tokens": 8192,
})
c["provider"] = provs

# 旧的 Ollama 源不再默认使用（保留但不删，方便回退）
for s in c["provider_sources"]:
    if s.get("type") == "ollama_embedding":
        s["enable"] = False

json.dump(c, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("   provider 已写入：", PROV_ID)
PY

echo "==> 切换 livingmemory 嵌入源"
python3 - "$PROV_ID" <<'PY'
import json, sys
prov = sys.argv[1]
p = "/root/data/config/astrbot_plugin_livingmemory_config.json"
d = json.load(open(p, encoding="utf-8-sig"))
ps = d.setdefault("provider_settings", {})
old = ps.get("embedding_provider_id")
ps["embedding_provider_id"] = prov
json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"   {old} → {prov}")
PY

echo "==> 重启 AstrBot"
systemctl restart astrbot
sleep 25
systemctl is-active astrbot

echo "==> 验证"
grep -a "OpenAI Embedding" "$DATA/logs/astrbot-stdout.log" | tail -n 3 | cut -c1-150 || true
grep -a "Ollama Embedding" "$DATA/logs/astrbot-stdout.log" | tail -n 2 | cut -c1-150 || true
curl -s -m 5 http://127.0.0.1:6188/room/ping || true
echo
echo "完成。索引无需重建（同为 bge-m3 / 1024 维）；如召回异常可让 livingmemory 重建索引。"
