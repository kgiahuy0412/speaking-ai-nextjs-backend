param(
  [int]$StartIndex = 0,
  [int]$MaxFiles = 20,
  [string]$Group = "",
  [string]$ExcludeGroup = "",
  [string]$OnlyFiles = "",
  [switch]$ForceRetest
)

$ErrorActionPreference = "Stop"
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$repo = "D:\Code\HuaMei\App_noi\be\3_23th7\speaking-ai-nextjs-backend"
$runDir = Join-Path $repo ".codex-tmp\audio-test-run"
$manifestPath = Join-Path $runDir "audio-probe-results.json"
$resultsPath = Join-Path $runDir "mobile-audio-test-results.jsonl"
$progressPath = Join-Path $runDir "mobile-audio-test-progress.json"
$evidenceDir = Join-Path $runDir "mobile-evidence"
$adb = "C:\Users\DELL\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$ffplay = (Get-Command ffplay -ErrorAction Stop).Source
$device = "emulator-5554"
$remoteXml = "/sdcard/codex_mobile_test_window.xml"
$remoteStatePng = "/sdcard/codex_recording_state.png"
$localStatePng = Join-Path $runDir "recording-state.png"

New-Item -ItemType Directory -Force -Path $runDir, $evidenceDir | Out-Null
Add-Type -AssemblyName System.Drawing

$previousStartupErrorPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  & $adb -s $device emu "avd hostmicon" 2>$null | Out-Null
} finally {
  $ErrorActionPreference = $previousStartupErrorPreference
}

function Get-RecordingVisualState {
  $previousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $adb -s $device shell screencap -p $remoteStatePng 2>$null | Out-Null
    & $adb -s $device pull $remoteStatePng $localStatePng 2>$null | Out-Null
  } finally {
    $ErrorActionPreference = $previousErrorPreference
  }

  $bitmap = [System.Drawing.Bitmap]::FromFile($localStatePng)
  try {
    $bottomColor = $bitmap.GetPixel(540, 2219)
    $recording = $bottomColor.R -gt 200 -and $bottomColor.G -lt 145 -and $bottomColor.B -lt 145

    $redStopRows = @()
    for ($sampleY = 820; $sampleY -le 1140; $sampleY += 10) {
      $color = $bitmap.GetPixel(650, $sampleY)
      if ($color.R -gt 200 -and $color.G -lt 160 -and $color.B -lt 150) {
        $redStopRows += $sampleY
      }
    }
    $stopY = if ($redStopRows.Count -gt 0) {
      [int](($redStopRows | Measure-Object -Average).Average)
    } else {
      950
    }

    return [pscustomobject]@{ Recording = $recording; StopY = $stopY }
  } finally {
    $bitmap.Dispose()
  }
}

function Test-RecordingActive {
  return [bool](Get-RecordingVisualState).Recording
}

function Wait-RecordingActive {
  param(
    [bool]$Expected,
    [int]$TimeoutMilliseconds = 5000
  )

  $deadline = (Get-Date).AddMilliseconds($TimeoutMilliseconds)
  do {
    if ((Test-RecordingActive) -eq $Expected) {
      return $true
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Stop-RecordingActive {
  $visualState = Get-RecordingVisualState
  if (-not $visualState.Recording) {
    return $true
  }

  for ($attempt = 1; $attempt -le 3; $attempt++) {
    & $adb -s $device shell input touchscreen tap 540 $visualState.StopY | Out-Null
    if (Wait-RecordingActive -Expected $false -TimeoutMilliseconds 2500) {
      return $true
    }
    $visualState = Get-RecordingVisualState
    if (-not $visualState.Recording) {
      return $true
    }
  }
  return $false
}

function Get-UiState {
  $xmlText = ""
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try {
      & $adb -s $device shell uiautomator dump $remoteXml 2>$null | Out-Null
      $xmlText = ((& $adb -s $device exec-out cat $remoteXml 2>$null) -join "")
    } catch {
      # uiautomator occasionally reports a transient idle-state error while
      # Flutter animations are settling. Retrying is safe and deterministic.
      $xmlText = ""
    }
    if ($xmlText.StartsWith("<?xml")) {
      break
    }
    Start-Sleep -Milliseconds 600
  }
  if (-not $xmlText.StartsWith("<?xml")) {
    throw "Không đọc được UI hierarchy từ Android Emulator."
  }

  [xml]$document = $xmlText
  $nodes = @($document.SelectNodes('//node'))
  $descriptions = @(
    $nodes |
      Where-Object { $_.'content-desc' } |
      ForEach-Object { [string]$_.'content-desc' } |
      Where-Object { $_ }
  )

  # The Vietnamese accessibility labels can be decoded differently by a
  # background Windows PowerShell process. Use stable emulator coordinates for
  # control-state detection and keep the labels only for result extraction.
  $bottomAction = [bool]($nodes | Where-Object {
    $_.bounds -eq "[53,2132][1028,2306]" -and $_.clickable -eq "true"
  })
  $bottomActionDescription = [string](
    $nodes |
      Where-Object { $_.bounds -eq "[53,2132][1028,2306]" -and $_.clickable -eq "true" } |
      Select-Object -First 1 |
      ForEach-Object { $_.'content-desc' }
  )
  $recording = [bool]($nodes | Where-Object {
    $_.bounds -eq "[367,973][713,1099]" -and $_.clickable -eq "true"
  })
  $ready = $bottomAction -and -not $recording
  $hasResult = $descriptions -contains "Đã có câu tiếng Anh"
  $listening = $recording

  $transcript = $null
  for ($index = 0; $index -lt $descriptions.Count - 1; $index++) {
    if ($descriptions[$index] -eq "Câu tiếng Việt") {
      $candidate = $descriptions[$index + 1].Trim()
      if ($candidate -and $candidate -notin @("Câu tiếng Anh", "Chưa có câu")) {
        $transcript = $candidate
      }
      break
    }
  }

  $english = $null
  for ($index = 0; $index -lt $descriptions.Count; $index++) {
    if ($descriptions[$index] -ne "Câu tiếng Anh") {
      continue
    }
    for ($candidateIndex = $index + 1; $candidateIndex -lt $descriptions.Count; $candidateIndex++) {
      $candidate = $descriptions[$candidateIndex].Trim()
      if (-not $candidate) { continue }
      if ($candidate -like "Phát*") { continue }
      if ($candidate -like "Đúng ý*") { continue }
      if ($candidate -like "Sai ý*") { continue }
      if ($candidate -like "Nói câu mới*") { break }
      if ($candidate -eq "Chưa có câu") { continue }
      $english = $candidate
      break
    }
    break
  }

  # Position fallback: the Flutter result values are the only semantic nodes
  # beginning at x=140 below the result card. This survives localized labels
  # and Windows console-decoding differences.
  $positionedResults = @(
    $nodes |
      Where-Object { $_.'content-desc' -and $_.bounds -match '^\[140,(\d+)\]\[' } |
      ForEach-Object {
        if ($_.bounds -match '^\[140,(\d+)\]\[') {
          [pscustomobject]@{ Y = [int]$Matches[1]; Value = [string]$_.'content-desc' }
        }
      } |
      Where-Object { $_.Y -gt 1050 } |
      Sort-Object Y
  )
  if ($positionedResults.Count -ge 2) {
    $transcript = $positionedResults[0].Value.Trim()
    $english = $positionedResults[1].Value.Trim()
  }
  if (-not $hasResult) {
    # The cards retain the previous sentence on idle/retry screens. Do not
    # attribute those stale values to the audio currently under test.
    $transcript = $null
    $english = $null
  }

  $errors = @(
    $descriptions |
      Where-Object {
        ($_ -match "(?i)lỗi|không thể|thử lại|hết thời gian|quá ngắn") -and
        ($_ -notmatch "OpenAI chỉ được backend dùng khi Cloudflare lỗi")
      } |
      Select-Object -Unique
  )

  [pscustomobject]@{
    Recording = $recording
    Ready = $ready
    HasResult = $hasResult
    Listening = $listening
    BlockingError = [bool]($bottomActionDescription -like "Thử lại*")
    Transcript = $transcript
    English = $english
    Errors = $errors
    Descriptions = $descriptions
  }
}

function Save-Evidence {
  param([string]$RelativePath)

  $safeName = ($RelativePath -replace '[\\/:*?"<>| ]', '_') + ".png"
  $remotePng = "/sdcard/codex_mobile_evidence.png"
  $localPng = Join-Path $evidenceDir $safeName
  $previousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $adb -s $device shell screencap -p $remotePng 2>$null | Out-Null
    & $adb -s $device pull $remotePng $localPng 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Không lưu được ảnh bằng chứng từ Android Emulator."
    }
  } finally {
    $ErrorActionPreference = $previousErrorPreference
  }
  return $localPng
}

function Write-Result {
  param($Result)

  $jsonLine = $Result | ConvertTo-Json -Depth 6 -Compress
  Add-Content -LiteralPath $resultsPath -Value $jsonLine -Encoding UTF8
}

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
$allFiles = @($manifest.results)

if ($Group) {
  $allFiles = @($allFiles | Where-Object { (Split-Path -Leaf (Split-Path -Parent $_.relativePath)) -eq $Group })
}
if ($ExcludeGroup) {
  $allFiles = @($allFiles | Where-Object { (Split-Path -Leaf (Split-Path -Parent $_.relativePath)) -ne $ExcludeGroup })
}
if ($OnlyFiles) {
  $wantedFiles = @($OnlyFiles.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $allFiles = @($allFiles | Where-Object { (Split-Path -Leaf $_.relativePath) -in $wantedFiles })
}

$completed = @{}
if ((Test-Path -LiteralPath $resultsPath) -and -not $ForceRetest) {
  foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $resultsPath) {
    if (-not $line.Trim()) { continue }
    try {
      $prior = $line | ConvertFrom-Json
      if ($prior.resultState -eq "success") {
        $completed[[string]$prior.relativePath] = $true
      }
    } catch {
      # Ignore a partial final line from an interrupted run.
    }
  }
}

$pending = @(
  $allFiles |
    Select-Object -Skip $StartIndex |
    Where-Object { -not $completed.ContainsKey([string]$_.relativePath) } |
    Select-Object -First $MaxFiles
)

$runStarted = Get-Date
$runId = $runStarted.ToString("yyyyMMdd-HHmmss")
$processed = 0

foreach ($audio in $pending) {
  $relativePath = [string]$audio.relativePath
  $absolutePath = [string]$audio.absolutePath
  $folder = Split-Path -Leaf (Split-Path -Parent $relativePath)
  $testStarted = Get-Date
  $playbackExitCode = $null
  $recordingStarted = $false
  $recordingStopped = $false
  $resultState = "unknown"
  $uiState = $null
  $evidencePath = $null
  $exceptionMessage = $null

  try {
    if (Test-RecordingActive) {
      if (-not (Stop-RecordingActive)) {
        throw "Không dừng được lượt ghi âm còn mở từ trước."
      }
      Start-Sleep -Milliseconds 3000
    }

    $initialState = Get-UiState
    $readyState = $initialState
    if (-not $readyState.Ready) {
      throw "Ứng dụng chưa ở trạng thái sẵn sàng cho lượt mới."
    }

    & $adb -s $device shell input tap 540 2219 | Out-Null
    if (-not (Wait-RecordingActive -Expected $true -TimeoutMilliseconds 12000)) {
      throw "Không chuyển được ứng dụng sang trạng thái ghi âm."
    }
    $recordingStarted = $true
    Start-Sleep -Milliseconds 800

    $ffplayProcess = Start-Process -FilePath $ffplay `
      -ArgumentList @("-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", "100", ('"' + $absolutePath + '"')) `
      -WindowStyle Hidden -Wait -PassThru
    $playbackExitCode = $ffplayProcess.ExitCode
    if ($playbackExitCode -ne 0) {
      throw "ffplay không phát được audio, exit code $playbackExitCode."
    }
    Start-Sleep -Milliseconds 900

    # VAD can stop automatically as the clip ends. Only tap the dedicated top
    # stop button when Android confirms that recording is still active; tapping
    # the bottom action after auto-stop would accidentally start another turn.
    if (-not (Stop-RecordingActive)) {
      throw "Không dừng được ghi âm sau khi phát audio."
    }
    $recordingStopped = $true

    $deadline = (Get-Date).AddSeconds(40)
    Start-Sleep -Milliseconds 3000
    while ((Get-Date) -lt $deadline) {
      try {
        $uiState = Get-UiState
      } catch {
        Start-Sleep -Milliseconds 900
        continue
      }
      if ($uiState.Ready -and -not $uiState.Recording) {
        break
      }
      Start-Sleep -Milliseconds 900
    }

    if (-not $uiState -or -not $uiState.Ready) {
      $resultState = "timeout"
      throw "Không nhận được kết quả trong 40 giây."
    }

    if ($uiState.BlockingError -or ($uiState.Errors.Count -gt 0 -and -not $uiState.HasResult)) {
      $resultState = "app_error"
    } elseif ($uiState.HasResult -and $uiState.Transcript -and $uiState.English) {
      $resultState = "success"
    } else {
      $resultState = "empty_result"
    }

    $needsEvidence =
      $resultState -ne "success" -or
      $uiState.Errors.Count -gt 0 -or
      $uiState.Transcript -match '^\s*[.?!,;:]+\s*$' -or
      $uiState.English -match '(?i)say that again|could not|try again|không thể|thử lại'

    if ($needsEvidence) {
      $evidencePath = Save-Evidence -RelativePath $relativePath
    }
  } catch {
    $exceptionMessage = $_.Exception.Message
    if ($resultState -eq "unknown") {
      $resultState = "automation_error"
    }
    try {
      $evidencePath = Save-Evidence -RelativePath $relativePath
    } catch {
      # Keep the original test failure if screenshot capture also fails.
    }
  }

  $completedAt = Get-Date
  $result = [ordered]@{
    runId = $runId
    recognitionMode = "standard"
    relativePath = $relativePath
    absolutePath = $absolutePath
    folder = $folder
    fileName = Split-Path -Leaf $relativePath
    bytes = [long]$audio.bytes
    durationSeconds = [double]$audio.durationSeconds
    codec = [string]$audio.codec
    sampleRate = [int]$audio.sampleRate
    channels = [int]$audio.channels
    resultState = $resultState
    transcript = if ($uiState) { $uiState.Transcript } else { $null }
    english = if ($uiState) { $uiState.English } else { $null }
    appErrors = if ($uiState) { @($uiState.Errors) } else { @() }
    blockingError = if ($uiState) { [bool]$uiState.BlockingError } else { $false }
    exception = $exceptionMessage
    playbackExitCode = $playbackExitCode
    recordingStarted = $recordingStarted
    recordingStopped = $recordingStopped
    elapsedSeconds = [math]::Round(($completedAt - $testStarted).TotalSeconds, 3)
    testedAt = $completedAt.ToString("o")
    evidencePath = $evidencePath
  }

  Write-Result -Result $result
  $processed++

  [ordered]@{
    runId = $runId
    group = $Group
    processedThisRun = $processed
    scheduledThisRun = $pending.Count
    totalCompleted = $completed.Count + $processed
    currentFile = $relativePath
    lastResultState = $resultState
    lastTranscript = $result.transcript
    lastEnglish = $result.english
    elapsedMinutes = [math]::Round(((Get-Date) - $runStarted).TotalMinutes, 2)
    updatedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $progressPath -Encoding UTF8

  Start-Sleep -Milliseconds 900
}

[ordered]@{
  runId = $runId
  group = $Group
  completed = $true
  processedThisRun = $processed
  scheduledThisRun = $pending.Count
  totalCompleted = $completed.Count + $processed
  elapsedMinutes = [math]::Round(((Get-Date) - $runStarted).TotalMinutes, 2)
  updatedAt = (Get-Date).ToString("o")
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $progressPath -Encoding UTF8
