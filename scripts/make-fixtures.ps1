# Synthesises the command-mode voice clips used by the self-test: powershell -File scripts/make-fixtures.ps1
# Needs the 'Microsoft Zira Desktop' voice. Does not touch dictation.wav, command.wav or snippet.wav, which are
# recordings. Check each new clip with: node scripts/bench-asr.cjs tests/fixtures/<name>.wav
Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$clips = [ordered]@{
  'open-charmap'  = 'Open Character Map.'
  'search'        = 'Search for standing desks.'
  'goto'          = 'Go to example dot com.'
  'saved-spanish' = 'Spanish.'
  'summarize'     = 'Summarize this in one sentence.'
}
$dir = Join-Path $PSScriptRoot '..\tests\fixtures'
foreach ($name in $clips.Keys) {
  $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voice.SelectVoice('Microsoft Zira Desktop')
  $voice.Rate = -1
  $voice.SetOutputToWaveFile((Join-Path $dir "$name.wav"), $format)
  $voice.Speak($clips[$name])
  $voice.Dispose()
}
