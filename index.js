// 💡 dotenvがインストールされていなくてもエラーにせず、あれば読み込む設定
try {
    require('dotenv').config();
} catch (e) {
    // Render本番環境など、dotenvがなくても落とさずに無視する
}

// 📦 必要なモジュールを一元管理（重複を排除）
const path = require('path');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase接続設定
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// 💡 デバッグ用：万が一空っぽの場合にRenderのログで検知できるようにする
console.log("[System Check] SUPABASE_URL exists:", !!supabaseUrl);
console.log("[System Check] SUPABASE_KEY exists:", !!supabaseKey);

let supabase;
if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
} else {
    console.error("❌ CRITICAL ERROR: Supabase環境変数が取得できませんでした。本番環境のEnvironment設定を確認してください。");
    supabase = createClient("https://dummy-url-prevent-crash.supabase.co", "dummy-key");
}

app.use(express.json());
app.use('/', express.static(path.join(__dirname, 'public')));

// 📥 エントリーチームのインポート処理 (CSVインポート用)
app.post('/api/teams/import', async (req, res) => {
    try {
        const teams = req.body;

        if (!Array.isArray(teams) || teams.length === 0) {
            return res.status(400).json({ success: false, error: 'インポートするデータがありません。' });
        }

        // Supabase へのデータ一括挿入
        const { data, error } = await supabase
            .from('teams')
            .insert(teams)
            .select();

        if (error) {
            console.error('❌ Supabase 挿入エラー:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        console.log(`✅ ${teams.length} チームのインポートに成功しました`);
        return res.json({ success: true, count: teams.length });

    } catch (err) {
        console.error('❌ サーバー内部エラー:', err);
        return res.status(500).json({ success: false, error: 'サーバー処理中にエラーが発生しました。' });
    }
});


// 📄 チーム一覧取得 API（tournament_setup.html のモード判定・一覧表示用）
app.get('/api/teams', async (req, res) => {
    try {
        const { data, error } = await supabase.from('teams').select('*');
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        console.error("チーム一覧取得エラー:", err);
        res.status(500).json({ error: err.message });
    }
});

// 試合結果取得
app.get('/api/matches', async (req, res) => {
  try {
    const { category } = req.query;
    
    let query = supabase.from('matches').select('*');
    
    // category が指定されている場合はフィルタリングを実施
    if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Error fetching matches:', error);
    res.status(500).json({ error: error.message });
  }
});

// 試合結果保存（新規作成用・互換性維持）
app.post('/api/match', async (req, res) => {
    try {
        const { category, stage, title, teamA, teamB, scoreA, scoreB, status, details, positions } = req.body;
        const parsedDetails = typeof details === 'string' ? JSON.parse(details) : (details || positions || []);

        const { data, error } = await supabase
            .from('matches')
            .insert([{
                category,
                stage,
                title,
                teamA,
                teamB,
                scoreA: parseInt(scoreA, 10) || 0,
                scoreB: parseInt(scoreB, 10) || 0,
                status: status || 'finished',
                details: parsedDetails
            }]);

        if (error) throw error;
        res.json({ success: true, data });
    } catch (err) {
        console.error("Supabase保存エラー:", err);
        res.status(500).json({ error: err.message });
    }
});

// 指定IDの試合結果更新（Step3 スコア更新用）
const updateMatchHandler = async (req, res) => {
    try {
        const matchId = req.params.id;
        const { scoreA, scoreB, score_a, score_b, status, details, positions } = req.body;
        let parsedDetails = typeof details === 'string' ? JSON.parse(details) : (details || positions || []);

        if (matchId) {
            const { data: existingMatch } = await supabase.from('matches').select('details').eq('id', matchId).single();
            if (existingMatch && existingMatch.details) {
                const oldDetails = typeof existingMatch.details === 'string' ? JSON.parse(existingMatch.details) : existingMatch.details;
                if (oldDetails && typeof oldDetails === 'object' && !Array.isArray(oldDetails)) {
                    parsedDetails = {
                        ...oldDetails,
                        order_list: Array.isArray(parsedDetails) ? parsedDetails : (parsedDetails.order_list || [])
                    };
                }
            }
        }

        const finalScoreA = parseInt(scoreA ?? score_a ?? 0, 10);
        const finalScoreB = parseInt(scoreB ?? score_b ?? 0, 10);

        const { data, error } = await supabase
            .from('matches')
            .update({
                scoreA: finalScoreA,
                scoreB: finalScoreB,
                status: status || 'finished',
                details: parsedDetails
            })
            .eq('id', matchId);

        if (error) throw error;
        res.json({ success: true, data });
    } catch (err) {
        console.error("Supabase更新エラー:", err);
        res.status(500).json({ error: err.message });
    }
};
app.put('/api/matches/:id', updateMatchHandler);
app.post('/api/matches/:id', updateMatchHandler);

// 🏆 決勝トーナメントの自動勝ち上がり専用関数（決勝戦終了ガード追加版）
async function autoAdvanceTournament({ category, title, teamA, teamB, scoreA, scoreB, parsedDetails }) {
    const { data: rawFinals } = await supabase.from('matches').select('*').eq('stage', '決勝トーナメント');
    const allFinals = (rawFinals || []).filter(m => m.category === category || !category);

    const getWinnerName = (m) => {
        if (!m || m.status !== 'finished') return null;
        const det = typeof m.details === 'string' ? JSON.parse(m.details) : m.details;
        if (det && det.winnerTeam) return det.winnerTeam;
        if (m.scoreA > m.scoreB) return m.teamA;
        if (m.scoreB > m.scoreA) return m.teamB;
        return null;
    };

    const currentTitle = title || '';

    const normalizeNum = (str) => {
        if (!str) return 0;
        const half = str.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
        return parseInt(half, 10) || 0;
    };

    const roundMatch = currentTitle.match(/([0-9０-９]+)回戦/);
    const matchMatch = currentTitle.match(/第([0-9０-９]+)試合/);

    if (!roundMatch || !matchMatch) {
        console.warn(`[Auto Advance Skip] タイトル "${currentTitle}" から回戦数・試合番号を取得できませんでした。`);
        return;
    }

    const roundNum = normalizeNum(roundMatch[1]);
    const matchNum = normalizeNum(matchMatch[1]);

    // 💡 決勝戦（全試合中の最大回戦）判定：決勝戦の場合は勝ち上がり生成を行わない
    const maxRound = Math.max(...allFinals.map(m => {
        const rm = m.title ? m.title.match(/([0-9０-９]+)回戦/) : null;
        return rm ? normalizeNum(rm[1]) : 0;
    }));

    if (roundNum >= maxRound && maxRound > 0) {
        console.log(`[Auto Advance Skip] ${roundNum}回戦は決勝戦のため、勝ち上がり枠の自動生成をスキップします。`);
        return;
    }

    const pairMatchNum = (matchNum % 2 === 1) ? matchNum + 1 : matchNum - 1;
    const nextMatchNum = Math.ceil(matchNum / 2);

    const currentMatch = allFinals.find(m => m.title && m.title.includes(`${roundNum}回戦 第${matchNum}試合`));
    const pairMatch = allFinals.find(m => m.title && m.title.includes(`${roundNum}回戦 第${pairMatchNum}試合`));

    const currentScoreA = parseInt(scoreA, 10) || 0;
    const currentScoreB = parseInt(scoreB, 10) || 0;

    const winnerCurrent = getWinnerName(currentMatch) 
        || (parsedDetails && parsedDetails.winnerTeam) 
        || (currentScoreA > currentScoreB ? teamA : (currentScoreB > currentScoreA ? teamB : null));
    const winnerPair = getWinnerName(pairMatch);

    console.log(`[Auto Advance] ${roundNum}回戦 第${matchNum}試合勝者: ${winnerCurrent}, ペア(第${pairMatchNum}試合)勝者: ${winnerPair}`);

    if (winnerCurrent || winnerPair) {
        const winnerA = (matchNum % 2 === 1) ? (winnerCurrent || '未定') : (winnerPair || '未定');
        const winnerB = (matchNum % 2 === 1) ? (winnerPair || '未定') : (winnerCurrent || '未定');

        const nextTitle = `${roundNum + 1}回戦 第${nextMatchNum}試合`;
        const existingNextMatch = allFinals.find(m => m.title && m.title.includes(nextTitle));

        if (existingNextMatch) {
            console.log(`[Auto Advance] 既存の ${nextTitle} を更新します: ${winnerA} vs ${winnerB}`);
            await supabase.from('matches').update({
                teamA: winnerA !== '未定' ? winnerA : existingNextMatch.teamA,
                teamB: winnerB !== '未定' ? winnerB : existingNextMatch.teamB
            }).eq('id', existingNextMatch.id);
        } else {
            console.log(`[Auto Advance] 新規に ${nextTitle} を作成します: ${winnerA} vs ${winnerB}`);
            await supabase.from('matches').insert([{
                category: category || currentMatch?.category,
                stage: '決勝トーナメント',
                title: nextTitle,
                teamA: winnerA,
                teamB: winnerB,
                scoreA: 0,
                scoreB: 0,
                status: 'scheduled',
                details: []
            }]);
        }
    }
}
// 📄 決勝トーナメント結果更新 API (final_input.html 用)
app.post('/api/match_update', async (req, res) => {
    try {
        const { id, category, stage, title, teamA, teamB, scoreA, scoreB, status, details } = req.body;

        // 1. まず ID による更新を試行
        let updatedMatch = null;
        
        if (id) {
            const { data, error } = await supabase
                .from('matches')
                .update({
                    scoreA: scoreA,
                    scoreB: scoreB,
                    status: status || 'finished',
                    details: details
                })
                .eq('id', id)
                .select();

            if (!error && data && data.length > 0) {
                updatedMatch = data[0];
            }
        }

        // 2. IDで対象が見つからなかった場合（直接生成でIDが変わっている等）、category + stage + title でフォールバック検索・更新
        if (!updatedMatch) {
            if (!category || !title) {
                return res.status(400).json({ success: false, error: '更新対象の試合を特定するための情報（ID または category/title）が不足しています。' });
            }

            const { data: fallbackData, error: fallbackError } = await supabase
                .from('matches')
                .update({
                    scoreA: scoreA,
                    scoreB: scoreB,
                    status: status || 'finished',
                    details: details
                })
                .eq('category', category)
                .eq('stage', stage || '決勝トーナメント')
                .eq('title', title)
                .select();

            if (fallbackError) throw fallbackError;

            if (fallbackData && fallbackData.length > 0) {
                updatedMatch = fallbackData[0];
            }
        }

        // 3. どちらの手段でも見つからない場合
        if (!updatedMatch) {
            throw new Error(`該当する試合が見つかりませんでした。(category: ${category}, title: ${title})`);
        }

        // 4. 勝者が確定していれば自動勝ち上がりを実行
        const winnerTeam = details?.winnerTeam;
        if (winnerTeam) {
            await autoAdvanceTournament(updatedMatch, winnerTeam);
        }

        res.json({ success: true, data: updatedMatch });
    } catch (err) {
        console.error("試合結果更新エラー:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ⚔️ トーナメント配置・部門別生成 API
app.post('/api/tournament/generate', async (req, res) => {
    const { category, type } = req.body;
    try {
        let inputTeams = (req.body.teams && Array.isArray(req.body.teams) && req.body.teams.length > 0)
            ? req.body.teams
            : [];

        let rawTeams = [];

        if (inputTeams.length === 0) {
            const { data: dbTeams, error: tError } = await supabase
                .from('teams')
                .select('*')
                .eq('category', category);

            if (tError) return res.status(500).json({ error: tError.message });
            if (!dbTeams || dbTeams.length < 2) return res.status(400).json({ error: 'チーム数が足りません' });
            
            rawTeams = dbTeams;
            inputTeams = dbTeams.map(t => t.team_name);
        } else {
            rawTeams = inputTeams.map(name => ({ team_name: name, organization: '未設定' }));
        }

        if (inputTeams.length < 2) {
            return res.status(400).json({ error: 'トーナメント作成に必要なチーム数が足りません（2チーム以上必要です）' });
        }

        let matchesToInsert = [];

        if (type === 'league') {
            const optimizedTeams = optimizeTeamDistribution(rawTeams);
            const totalTeams = optimizedTeams.length;

            let count4 = totalTeams % 3;
            let count3 = Math.floor(totalTeams / 3) - count4;

            if (count3 < 0) {
                if (totalTeams === 4) { count4 = 1; count3 = 0; } 
                else if (totalTeams === 5) { count4 = 1; count3 = 1; } 
                else { count4 = 0; count3 = Math.ceil(totalTeams / 3); }
            }

            const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
            const getGroupName = (index) => {
                if (index < 26) return `${alphabet[index]}リーグ`;
                const firstChar = alphabet[Math.floor(index / 26) - 1];
                const secondChar = alphabet[index % 26];
                return `${firstChar}${secondChar}リーグ`;
            };

            let teamIndex = 0;
            let currentGroupIdx = 0;

            const buildLeagueGroups = (groupCount, leagueSize) => {
                for (let g = 0; g < groupCount; g++) {
                    const groupName = getGroupName(currentGroupIdx);
                    let curLeagueTeams = optimizedTeams.slice(teamIndex, teamIndex + leagueSize);

                    while (curLeagueTeams.length < leagueSize) {
                        curLeagueTeams.push({ team_name: '（不戦勝枠）', organization: 'なし' });
                    }

                    const maxPromoted = leagueSize === 4 ? 2 : 1;
                    let matchCount = 1;

                    for (let i = 0; i < curLeagueTeams.length; i++) {
                        for (let j = i + 1; j < curLeagueTeams.length; j++) {
                            const teamA = curLeagueTeams[i].team_name;
                            const teamB = curLeagueTeams[j].team_name;
                            const isBye = teamA === '（不戦勝枠）' || teamB === '（不戦勝枠）';
                            const isSameOrg = curLeagueTeams[i].organization === curLeagueTeams[j].organization;

                            matchesToInsert.push({
                                category,
                                stage: '予選リーグ',
                                title: `${groupName} 第${matchCount}試合`,
                                teamA,
                                teamB,
                                scoreA: teamA === '（不戦勝枠）' ? 0 : (isBye ? 1 : 0),
                                scoreB: teamB === '（不戦勝枠）' ? 0 : (isBye ? 1 : 0),
                                status: isBye ? 'finished' : 'scheduled',
                                details: { 
                                    same_org: isSameOrg, 
                                    league: groupName, 
                                    round: matchCount,
                                    league_size: leagueSize,
                                    max_promoted: maxPromoted 
                                }
                            });
                            matchCount++;
                        }
                    }
                    teamIndex += leagueSize;
                    currentGroupIdx++;
                }
            };

            if (count3 > 0) buildLeagueGroups(count3, 3);
            if (count4 > 0) buildLeagueGroups(count4, 4);

        } else if (type === 'final' || type === 'tournament') {
            // 💡 既存ロジックを崩さず、元のチーム一覧のコピーをランダムにシャッフル
            const shuffledTeams = [...inputTeams];
            for (let i = shuffledTeams.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffledTeams[i], shuffledTeams[j]] = [shuffledTeams[j], shuffledTeams[i]];
            }

            const N = shuffledTeams.length;

            let T = 2;
            while (T < N) { T *= 2; }

            // 💡 標準シード配置順を求める関数（上下均等分散）
            const getSeedOrder = (size) => {
                if (size === 2) return [0, 1];
                const half = getSeedOrder(size / 2);
                return half.flatMap(x => [x, size - 1 - x]);
            };

            const seedPositions = getSeedOrder(T);
            const byeIndices = new Set(seedPositions.slice(N));

            // 初期スロットの割り当て
            let currentSlots = new Array(T).fill(null);
            let teamIdx = 0;
            for (let i = 0; i < T; i++) {
                if (byeIndices.has(i)) {
                    currentSlots[i] = '（シード）';
                } else {
                    currentSlots[i] = shuffledTeams[teamIdx++]; // 💡 シャッフルされたチーム順で配置
                }
            }

            const totalRounds = Math.log2(T);
            let activeSlots = currentSlots; // 各ラウンドの参加チーム一覧

            // 🏆 1回戦から決勝戦まで順番に生成していく完全単一ループ処理
            for (let r = 1; r <= totalRounds; r++) {
                const nextSlots = [];
                let matchNum = 1;

                for (let i = 0; i < activeSlots.length; i += 2) {
                    const teamA = activeSlots[i] || '未定';
                    const teamB = activeSlots[i + 1] || '未定';

                    const isByeA = teamA === '（シード）';
                    const isByeB = teamB === '（シード）';

                    // 両方シード枠の場合は試合自体をスキップ
                    if (isByeA && isByeB) {
                        nextSlots.push('（シード）');
                        continue;
                    }

                    let status = 'scheduled';
                    let scoreA = 0;
                    let scoreB = 0;
                    let winnerName = null;

                    // 片方がシード（不戦勝）の場合
                    if (isByeA || isByeB) {
                        status = 'finished';
                        scoreA = isByeB ? 1 : 0;
                        scoreB = isByeA ? 1 : 0;
                        winnerName = isByeB ? teamA : teamB;
                        nextSlots.push(winnerName); // 勝者を次のラウンドのスロットへ
                    } else {
                        nextSlots.push('未定'); // 試合が行われる場合は次ラウンドは「未定」
                    }

                    matchesToInsert.push({
                        category: category,
                        stage: '決勝トーナメント',
                        title: `${r}回戦 第${matchNum}試合`,
                        teamA: teamA,
                        teamB: teamB,
                        scoreA: scoreA,
                        scoreB: scoreB,
                        status: status,
                        details: {
                            round: r,
                            match_index: matchNum,
                            total_slots: activeSlots.length,
                            winnerTeam: winnerName
                        }
                    });
                    matchNum++;
                }

                // 次のラウンドへ進む
                activeSlots = nextSlots;
            }
        }

        // 💾 既存データの削除処理（クリーンアップ）
        let delQuery = supabase.from('matches').delete().eq('category', category);
        if (type === 'final' || type === 'tournament') {
            delQuery = delQuery.eq('stage', '決勝トーナメント');
        } else {
            delQuery = delQuery.eq('stage', '予選リーグ');
        }

        const { error: delError } = await delQuery;
        const stageName = (type === 'final' || type === 'tournament') ? '決勝トーナメント' : '予選リーグ';

        if (delError) {
            console.error(`[Generate Error] 既存の${stageName}データの削除に失敗:`, delError);
            return res.status(500).json({ error: `既存データのクリーンアップ失敗: ${delError.message}` });
        }

        // 💾 生成したデータの保存（Supabase Insert）
        const { data: insertedData, error: iError } = await supabase
            .from('matches')
            .insert(matchesToInsert)
            .select();

        if (iError) {
            console.error(`[Generate Error] ${stageName}データの保存に失敗:`, iError);
            return res.status(500).json({ error: `試合データの保存に失敗しました: ${iError.message}` });
        }

        return res.json({ 
            success: true, 
            message: `${category} の${stageName}（${matchesToInsert.length}試合）を正常に生成・上書きしました。` 
        });

    } catch (err) {
        console.error("生成処理内エラー:", err);
        return res.status(500).json({ error: err.message });
    }
});


// 🎲 配列をランダムにシャッフルするヘルパー関数（Fisher-Yates）
function shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// ⚔️ 同門回避 1次元チーム配列生成ロジック（完全ランダム対応）
function optimizeTeamDistribution(teams) {
    if (!teams || teams.length === 0) return [];

    // 1. 全チームを最初にランダムシャッフル
    const shuffledTeams = shuffleArray(teams);

    // 2. 団体（道場・所属）ごとにチームをグループ化
    const orgGroups = {};
    shuffledTeams.forEach(team => {
        const org = team.organization || team.team_name;
        if (!orgGroups[org]) orgGroups[org] = [];
        orgGroups[org].push(team);
    });

    // 3. チーム数が多い順にソート（同人数の団体同士はランダムに並び替え）
    const sortedOrgNames = Object.keys(orgGroups).sort((a, b) => {
        const diff = orgGroups[b].length - orgGroups[a].length;
        if (diff !== 0) return diff;
        return Math.random() - 0.5;
    });

    // 4. 各団体のチーム配列もシャッフル
    const orgQueues = sortedOrgNames.map(org => shuffleArray(orgGroups[org]));

    // 5. 交互（ラウンドロビン）に1次元配列へ展開して同門の集中を回避
    const result = [];
    let added = true;
    while (added) {
        added = false;
        for (const queue of orgQueues) {
            if (queue.length > 0) {
                result.push(queue.shift());
                added = true;
            }
        }
    }

    return result;
}


// 💾 手動組み替え後の予選リーグ保存 API
app.post('/api/tournament/save_league', async (req, res) => {
    const { category, matches } = req.body;
    try {
        if (!category || !Array.isArray(matches) || matches.length === 0) {
            return res.status(400).json({ success: false, error: '有効なデータが送信されませんでした。' });
        }

        const { error: delError } = await supabase
            .from('matches')
            .delete()
            .eq('category', category)
            .eq('stage', '予選リーグ');

        if (delError) return res.status(500).json({ success: false, error: delError.message });

        const { data, error: insError } = await supabase
            .from('matches')
            .insert(matches)
            .select();

        if (insError) return res.status(500).json({ success: false, error: insError.message });

        return res.json({ success: true, count: data ? data.length : 0 });

    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 🏆 確定した決勝トーナメント表の保存 API
app.post('/api/tournament/save_final', async (req, res) => {
    const { category, matches } = req.body;
    try {
        if (!category || !Array.isArray(matches) || matches.length === 0) {
            return res.status(400).json({ success: false, error: '有効なデータが送信されませんでした。' });
        }

        const { error: delError } = await supabase
            .from('matches')
            .delete()
            .eq('category', category)
            .eq('stage', '決勝トーナメント');

        if (delError) return res.status(500).json({ success: false, error: delError.message });

        const { data, error: insError } = await supabase
            .from('matches')
            .insert(matches)
            .select();

        if (insError) return res.status(500).json({ success: false, error: insError.message });

        return res.json({ success: true, count: data ? data.length : 0 });

    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 🚀 サーバー起動
app.listen(PORT, () => {
    console.log(`[🟢 Server Active] Tournament Manager is running on port ${PORT}`);
});
