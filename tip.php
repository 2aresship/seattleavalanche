<?php
/**
 * Avalanche tip drop box — handles text + file uploads.
 * Stores submissions above the public web root when possible,
 * falling back to data/tips.json inside the site for local hosting.
 * Returns JSON {ok, id, files} for the JS fetch handler.
 */

header("Content-Type: application/json; charset=utf-8");
header("X-Robots-Tag: noindex");

function out($ok, $extra) {
    $base = ["ok" => $ok];
    if (is_string($extra)) $base["msg"] = $extra;
    else $base = array_merge($base, $extra);
    echo json_encode($base, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// Honeypot — submit.html uses _gotcha (hidden). Also accept legacy "website".
if (!empty($_POST["_gotcha"]) || !empty($_POST["website"])) {
    out(true, ["msg" => "Thanks.", "id" => "filtered"]);
}

if (($_SERVER["REQUEST_METHOD"] ?? "") !== "POST") {
    out(false, ["error" => "POST required."]);
}

// Rate limit: one per IP per 30s (file-based, survives restarts)
$rateFile = sys_get_temp_dir() . "/av_rate_" . md5(__DIR__) . ".json";
$now = time();
$ip = $_SERVER["REMOTE_ADDR"] ?? "unknown";
$rates = [];
if (is_readable($rateFile)) { $rates = json_decode((string)file_get_contents($rateFile), true) ?: []; }
if (isset($rates[$ip]) && ($now - (int)$rates[$ip]) < 30) {
    out(false, ["error" => "Easy there — one submission per 30 seconds."]);
}
$rates[$ip] = $now;
if (count($rates) > 5000) $rates = array_slice($rates, -1000, null, true);
@file_put_contents($rateFile, json_encode($rates));

function clean($k, $max) {
    $v = trim((string)($_POST[$k] ?? ""));
    $v = str_replace(["\r\n", "\r"], "\n", $v);
    if (strlen($v) > $max) $v = substr($v, 0, $max);
    return $v;
}

$message = clean("message", 30000);
if ($message === "") {
    out(false, ["error" => "Message was empty."]);
}

// Generate short reference ID
$tipId = "AV-" . gmdate("Ymd") . "-" . strtoupper(substr(bin2hex(random_bytes(3)), 0, 6));

$allowedExt = ["pdf","txt","md","csv","xlsx","docx","zip","jpg","jpeg","png","webp","gif","mp3","wav","mp4","mov","eml","msg"];
$maxEach = 8 * 1024 * 1024;
$maxFiles = 5;

// Collect uploaded files info
$savedFiles = [];
$filesError = null;

if (!empty($_FILES["files"])) {
    $raw = $_FILES["files"];
    // Normalize to array of file entries
    $count = is_array($raw["name"]) ? count($raw["name"]) : 1;
    if ($count > $maxFiles) {
        out(false, ["error" => "Too many files — up to $maxFiles at a time."]);
    }
    for ($i = 0; $i < $count; $i++) {
        $name = is_array($raw["name"]) ? $raw["name"][$i] : $raw["name"];
        $tmp  = is_array($raw["tmp_name"]) ? $raw["tmp_name"][$i] : $raw["tmp_name"];
        $err  = is_array($raw["error"]) ? $raw["error"][$i] : $raw["error"];
        $size = is_array($raw["size"]) ? $raw["size"][$i] : $raw["size"];
        if ($err === UPLOAD_ERR_NO_FILE) continue;
        if ($err !== UPLOAD_ERR_OK) { $filesError = "Upload error for $name."; break; }
        if ($size > $maxEach) { $filesError = "$name exceeds 8 MB."; break; }
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        if ($ext !== "" && !in_array($ext, $allowedExt, true)) {
            $filesError = "$name: file type not allowed.";
            break;
        }
        // Sanitize filename
        $safe = preg_replace('/[^a-zA-Z0-9._-]/', '_', basename($name));
        if ($safe === "" || $safe === "." ) $safe = "file_$i.$ext";
        $savedFiles[] = ["orig" => $name, "safe" => $safe, "tmp" => $tmp, "size" => $size];
    }
    if ($filesError) out(false, ["error" => $filesError]);
}

$tip = [
    "id"           => $tipId,
    "received"     => gmdate("Y-m-d H:i:s") . " UTC",
    "topic"        => clean("topic", 60) ?: "tip",
    "alias"        => clean("alias", 60),
    "contact"      => clean("contact", 200),
    "handle"       => clean("alias", 60), // alias for compatibility
    "message"      => $message,
    "allow_public" => !empty($_POST["allow_public"]) ? 1 : 0,
    "files"        => array_map(function($f){ return $f["safe"]; }, $savedFiles),
    "meta"         => ["lang" => substr(clean("lang", 20), 0, 20)],
];

// Decide storage locations
$aboveRoot = dirname(__DIR__) . "/tips-dropbox.json";
$aboveFilesDir = dirname(__DIR__) . "/tips-files";
$localData = __DIR__ . "/data/tips.json";
$localFilesDir = __DIR__ . "/data/tips_files";

$useAbove = is_writable(dirname(__DIR__)) || is_writable($aboveRoot) || !file_exists($aboveRoot);

if ($useAbove && @is_dir(dirname(__DIR__))) {
    // Try above-root first (not browsable on shared hosts)
    $line = json_encode($tip, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $fp = @fopen($aboveRoot, "c+");
    if ($fp) {
        if (flock($fp, LOCK_EX)) {
            $stat = fstat($fp);
            fseek($fp, $stat["size"]);
            fwrite($fp, $line . "\n");
            fflush($fp);
            flock($fp, LOCK_UN);
        }
        fclose($fp);
    } else {
        // fallback to local
        $useAbove = false;
    }
    if ($useAbove && $savedFiles) {
        $destDir = $aboveFilesDir . "/" . $tipId;
        @mkdir($destDir, 0755, true);
        foreach ($savedFiles as $f) {
            @move_uploaded_file($f["tmp"], $destDir . "/" . $f["safe"]);
        }
    }
}

if (!$useAbove || !file_exists($aboveRoot)) {
    // Local fallback: data/tips.json + data/tips_files/<id>/
    @mkdir(dirname($localData), 0755, true);
    $existing = [];
    if (is_readable($localData)) {
        $raw = file_get_contents($localData);
        $existing = json_decode($raw, true);
        if (!is_array($existing)) $existing = [];
    }
    $existing[] = $tip;
    @file_put_contents($localData, json_encode($existing, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));

    if ($savedFiles) {
        $destDir = $localFilesDir . "/" . $tipId;
        @mkdir($destDir, 0755, true);
        foreach ($savedFiles as $f) {
            // move_uploaded_file may fail in CLI tests, fallback to rename/copy
            if (!@move_uploaded_file($f["tmp"], $destDir . "/" . $f["safe"])) {
                @rename($f["tmp"], $destDir . "/" . $f["safe"]);
                if (!file_exists($destDir . "/" . $f["safe"])) @copy($f["tmp"], $destDir . "/" . $f["safe"]);
            }
        }
    }
}

out(true, ["msg" => "Received.", "id" => $tipId, "files" => count($savedFiles)]);
