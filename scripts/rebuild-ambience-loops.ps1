param(
  [string]$SrcDir = "C:\Users\liato\dafeiyu-room\_tmp\audio-src",
  [string]$OutDir = "C:\Users\liato\dafeiyu-room\app\public\room\assets\sound\ambience"
)
$ff = "C:\AAAAAplications\ACommonTools\FFmpegFreeUI\ffmpeg.exe"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# name, source, start(ss), total length T, crossfade X, filter chain
$jobs = @(
  @{ n="wind.ogg";     i="wind1.wav";        ss=4;  T=19.0; X=1.6; eq="highpass=f=70,lowpass=f=5200";  ln="-27" },
  @{ n="rain.ogg";     i="rain-gutter.mp3";  ss=8;  T=20.0; X=1.5; eq="highpass=f=220,lowpass=f=9000"; ln="-26" },
  @{ n="storm.ogg";    i="rain-thunder.ogg"; ss=20; T=24.0; X=1.8; eq="highpass=f=40,lowpass=f=10000"; ln="-25" },
  @{ n="birds.ogg";    i="birds.ogg";        ss=3;  T=20.0; X=1.2; eq="highpass=f=300";                ln="-29" },
  @{ n="crickets.ogg"; i="crickets.mp3";     ss=2;  T=20.0; X=1.2; eq="highpass=f=1200,lowpass=f=8000"; ln="-31" },
  @{ n="drip.ogg";     i="drip.flac";        ss=10; T=13.0; X=1.0; eq="highpass=f=120";                ln="-29" }
)

foreach ($j in $jobs) {
  $src = Join-Path $SrcDir $j.i
  $out = Join-Path $OutDir $j.n
  if (-not (Test-Path $src)) { Write-Host "missing $($j.i)"; continue }
  $T = [double]$j.T; $X = [double]$j.X
  $L = $T - $X
  $fc = "[0]atrim=0:${T},asetpts=N/SR/TB,asplit=3[a][b][c];" +
        "[a]atrim=0:${X},asetpts=N/SR/TB[head];" +
        "[b]atrim=${L}:${T},asetpts=N/SR/TB[tail];" +
        "[c]atrim=${X}:${L},asetpts=N/SR/TB[mid];" +
        "[tail][head]acrossfade=d=${X}:c1=tri:c2=tri[cf];" +
        "[cf][mid]concat=n=2:v=0:a=1[cat];" +
        "[cat]$($j.eq),loudnorm=I=$($j.ln):TP=-3:LRA=7,aresample=44100[out]"
  & $ff -v error -y -ss $j.ss -i $src -filter_complex $fc -map "[out]" -ac 1 -c:a libvorbis -q:a 3 $out
  if (Test-Path $out) { "{0,-14} {1,6:N0} KB" -f $j.n, ((Get-Item $out).Length/1kb) } else { "{0,-14} FAIL" -f $j.n }
}
