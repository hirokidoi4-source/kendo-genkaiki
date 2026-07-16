
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const os = require('os');
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

// データベースの初期化
const db = new sqlite3.Database('./kendo_tournament.db', (err) => {
    if (err) console.error(err.message);
    console.log('📦 SQLiteデータベースに接続しました。');
});

// テーブル作成
db.serialize(() => {
    // ① 最終結果用のテーブル
    db.run(`CREATE TABLE IF NOT EXISTS tournament_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        winner TEXT,
        runner_up TEXT,
        third_place_1 TEXT,
        third_place_2 TEXT,
        status TEXT
    )`);

    // 初期データ（なければ作成）
    db.get("SELECT COUNT(*) as count FROM tournament_results", [], (err, row) => {
        if (row.count === 0) {
            const stmt = db.prepare("INSERT INTO tournament_results (title, winner, runner_up, third_place_1, third_place_2, status) VALUES (?, ?, ?, ?, ?, ?)");
            stmt.run('第21回 宗像少年剣道大会（中学生の部）', '-', '-', '-', '-', 'ongoing');
            stmt.finalize();
        }
    });

    // ② 【新規追加】各試合のスコア・詳細データ用のテーブル
    db.run(`CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT,       -- 部門（例: low_elem）
        stage TEXT,          -- 予選か決勝か（例: league）
        title TEXT,          -- 試合名（例: Aリーグ 第1試合）
        teamA TEXT,          -- 左チーム名
        teamB TEXT,          -- 右チーム名
        scoreA INTEGER,      -- 左チーム勝者数
        scoreB INTEGER,      -- 右チーム勝者数
        status TEXT,         -- ongoing(試合中) or finished(終了)
        details TEXT         -- 個人の打突データ（JSON文字列として保存）
    )`);
});

// ==========================================
// API エンドポイント
// ==========================================

// 【GET】最終結果の取得
app.get('/api/results', (req, res) => {
    db.get("SELECT * FROM tournament_results ORDER BY id DESC LIMIT 1", [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || { status: 'ongoing' });
    });
});

// 【POST】最終結果の保存
app.post('/api/results', (req, res) => {
    const { title, winner, runner_up, third_place_1, third_place_2, status } = req.body;
    const stmt = db.prepare("INSERT INTO tournament_results (title, winner, runner_up, third_place_1, third_place_2, status) VALUES (?, ?, ?, ?, ?, ?)");
    stmt.run(title, winner, runner_up, third_place_1, third_place_2, status, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
    stmt.finalize();
});

// 【GET】全試合データの取得（観客画面用）
app.get('/api/matches', (req, res) => {
    // 全試合データを取得
    db.all("SELECT * FROM matches ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // 保存されているJSON文字列(details)を、JavaScriptの配列に戻して返す
        const matches = rows.map(row => ({
            ...row,
            details: row.details ? JSON.parse(row.details) : []
        }));
        res.json(matches);
    });
});

// 【POST】試合結果の保存（Step3 試合入力画面用）
app.post('/api/match', (req, res) => {
    const { category, stage, title, teamA, teamB, scoreA, scoreB, status, details } = req.body;
    
    // 詳細データ（配列）をそのまま文字(JSON)に変換
    const detailsJson = JSON.stringify(details);

    const stmt = db.prepare("INSERT INTO matches (category, stage, title, teamA, teamB, scoreA, scoreB, status, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    stmt.run(category, stage, title, teamA, teamB, scoreA, scoreB, status, detailsJson, function(err) {
        if (err) {
            console.error("試合データの保存エラー:", err);
            return res.status(500).json({ error: err.message });
        }
        console.log(`✅ 試合データを保存しました！(試合名: ${title})`);
        res.json({ success: true, id: this.lastID });
    });
    stmt.finalize();
});

// ==========================================
// サーバー起動
// ==========================================
const getLocalIpAddress = () => {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) return alias.address;
        }
    }
    return 'localhost';
};

app.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIpAddress();
    console.log(`\n🚀 サーバーが起動しました！`);
    console.log(`💻 運営席ダッシュボード: http://localhost:${PORT}/admin.html`);
    console.log(`📱 観客席（結果閲覧）: http://${ip}:${PORT}/spectator.html\n`);
});
