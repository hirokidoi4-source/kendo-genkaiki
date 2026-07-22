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
    // プロセスがクラッシュして死ぬのを防ぐため、ダミーで初期化するか一旦保留にする
    supabase = createClient("https://dummy-url-prevent-crash.supabase.co", "dummy-key");
}

app.use(express.json());
app.use('/', express.static(path.join(__dirname, 'public')));

// 試合結果取得
app.get('/api/matches', async (req, res) => {
    const { data, error } = await supabase.from('matches').select('*').order('id', { ascending: false });
    res.json(data || []);
});

// 試合結果保存
// 【POST】新規作成（互換性用）
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

// 【PUT/POST】指定IDの試合結果更新（Step3 スコア更新用）
const updateMatchHandler = async (req, res) => {
    try {
        const matchId = req.params.id;
        const { scoreA, scoreB, score_a, score_b, status, details, positions } = req.body;
        const parsedDetails = typeof details === 'string' ? JSON.parse(details) : (details || positions || []);

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

// 【決勝勝ち上がり自動生成付き】試合結果を「更新」または「新規保存」するAPI
app.post('/api/match_update', async (req, res) => {
    try {
        const { id, category, stage, title, teamA, teamB, scoreA, scoreB, status, details } = req.body;
        let parsedDetails = typeof details === 'string' ? JSON.parse(details) : details;

        if (id) {
            const { data: existingMatch } = await supabase.from('matches').select('details').eq('id', id).single();
            if (existingMatch && existingMatch.details) {
                const oldDetails = typeof existingMatch.details === 'string' ? JSON.parse(existingMatch.details) : existingMatch.details;
                
                if (oldDetails && typeof oldDetails === 'object' && !Array.isArray(oldDetails)) {
                    parsedDetails = {
                        ...oldDetails,
                        order_list: Array.isArray(parsedDetails) ? parsedDetails : (parsedDetails.order_list || [])
                    };
                } else if (oldDetails && oldDetails.league) {
                    parsedDetails = {
                        league: oldDetails.league,
                        league_size: oldDetails.league_size,
                        max_promoted: oldDetails.max_promoted,
                        order_list: parsedDetails
                    };
                }
            }
        }

        const rowData = {
            category,
            stage,
            title,
            teamA,
            teamB,
            scoreA: parseInt(scoreA, 10) || 0,
            scoreB: parseInt(scoreB, 10) || 0,
            status,
            details: parsedDetails
        };

        let result;
        if (id) {
            const { data, error } = await supabase.from('matches').update(rowData).eq('id', id).select();
            if (error) throw error;
            result = data;
        } else {
            const { data, error } = await supabase.from('matches').insert([rowData]).select();
            if (error) throw error;
            result = data;
        }

        if (status === 'finished' && stage === '決勝トーナメント') {
            const { data: allFinals } = await supabase.from('matches').select('*').eq('category', category).eq('stage', '決勝トーナメント');
            
            const getWinnerName = (m) => {
                if (!m || m.status !== 'finished') return null;
                return m.scoreA > m.scoreB ? m.teamA : m.teamB;
            };

            const m1 = allFinals.find(m => m.title.includes('1回戦 第1試合'));
            const m2 = allFinals.find(m => m.title.includes('1回戦 第2試合'));
            const m3 = allFinals.find(m => m.title.includes('1回戦 第3試合'));
            const semi1 = allFinals.find(m => m.title.includes('準決勝 第1試合'));
            const semi2 = allFinals.find(m => m.title.includes('準決勝 第2試合'));
            const fin = allFinals.find(m => m.title.includes('決勝戦'));

            if (m1 && m2 && m1.status === 'finished' && m2.status === 'finished' && !semi1) {
                const w1 = getWinnerName(m1);
                const w2 = getWinnerName(m2);
                if (w1 && w2) {
                    await supabase.from('matches').insert([{
                        category, stage: '決勝トーナメント', title: '準決勝 第1試合',
                        teamA: w1, teamB: w2, scoreA: 0, scoreB: 0, status: 'scheduled', details: []
                    }]);
                }
            }

            if (m3 && m3.status === 'finished' && !semi2) {
                const w3 = getWinnerName(m3);
                if (w3) {
                    await supabase.from('matches').insert([{
                        category, stage: '決勝トーナメント', title: '準決勝 第2試合',
                        teamA: w3, teamB: '（シードにより不戦勝）', scoreA: 1, scoreB: 0, status: 'finished', details: []
                    }]);
                }
            }

            const { data: updatedFinals } = await supabase.from('matches').select('*').eq('category', category).eq('stage', '決勝トーナメント');
            const s1 = updatedFinals.find(m => m.title.includes('準決勝 第1試合'));
            const s2 = updatedFinals.find(m => m.title.includes('準決勝 第2試合'));

            if (s1 && s2 && s1.status === 'finished' && s2.status === 'finished' && !fin) {
                const winnerSemi1 = getWinnerName(s1);
                const winnerSemi2 = s2.teamA;
                if (winnerSemi1 && winnerSemi2) {
                    await supabase.from('matches').insert([{
                        category, stage: '決勝トーナメント', title: '🏆 決勝戦',
                        teamA: winnerSemi1, teamB: winnerSemi2, scoreA: 0, scoreB: 0, status: 'scheduled', details: []
                    }]);
                }
            }
        }

        res.json({ success: true, data: result });
    } catch (err) {
        console.error("試合データ更新エラー:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/results', async (req, res) => {
    const { data, error } = await supabase.from('tournament_results').select('*').order('id', { ascending: false }).limit(1);
    res.json(data && data.length > 0 ? data[0] : { status: 'ongoing' });
});

app.post('/api/results', async (req, res) => {
    const { data, error } = await supabase.from('tournament_results').insert([req.body]);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

app.get('/api/teams', async (req, res) => {
    const { data, error } = await supabase.from('teams').select('*').order('id', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

app.post('/api/teams/import', async (req, res) => {
    const incomingTeams = req.body; 
    
    if (!Array.isArray(incomingTeams) || incomingTeams.length === 0) {
        return res.status(400).json({ success: false, error: '有効なチームデータがありません。' });
    }

    try {
        console.log(`[Import] インポート処理を開始します。受信件数: ${incomingTeams.length}件`);

        const { error: deleteError } = await supabase
            .from('teams')
            .delete()
            .neq('id', 0);

        if (deleteError) {
            console.error('[Import Error] 既存データの削除に失敗しました:', deleteError);
            return res.status(500).json({ 
                success: false, 
                error: `既存データのクリーンアップに失敗しました。SupabaseのRLS設定（DELETE権限）を確認してください。詳細: ${deleteError.message}` 
            });
        }
        console.log('[Import] 既存データのクリーンアップが正常に完了しました（0件になりました）。');

        const categoryMap = {
            '小学生低学年': 'low_elem',
            '小学生団体': 'elem',
            '中学生団体': 'mid',
            '中学女子団体': 'mid_girls',
            'low_elem': 'low_elem',
            'elem': 'elem',
            'mid': 'mid',
            'mid_girls': 'mid_girls'
        };

        const formattedTeams = incomingTeams.map((t, index) => {
            const rawCategory = (t.category || '').trim();
            const mappedCategory = categoryMap[rawCategory];

            if (!mappedCategory) {
                console.warn(`[Import Warning] 未定義の部門名が検出されました(${index + 1}行目): "${rawCategory}"。そのまま登録を試みます。`);
            }

            return {
                category: mappedCategory || rawCategory, 
                team_name: (t.team_name || '').trim(),
                organization: (t.organization || '').trim()
            };
        });

        const { data, error: insertError } = await supabase
            .from('teams')
            .insert(formattedTeams)
            .select();

        if (insertError) {
            console.error('[Import Error] データのインサートに失敗しました:', insertError);
            return res.status(500).json({ success: false, error: `新規データの登録に失敗しました: ${insertError.message}` });
        }

        console.log(`[Import Success] インポートが正常に完了しました。登録件数: ${formattedTeams.length}件`);
        
        return res.json({ 
            success: true, 
            count: formattedTeams.length,
            message: 'データを完全に初期化し、新しくインポートしました。' 
        });

    } catch (err) {
        console.error('[Import Critical Error] システムエラーが発生しました:', err);
        return res.status(500).json({ success: false, error: 'サーバー内で予期せぬエラーが発生しました。' });
    }
});

// =================================================================
// ⚔️ 公正なトーナメント配置・部門別生成 API
// =================================================================
app.post('/api/tournament/generate', async (req, res) => {
    const { category, type } = req.body;
    try {
        // 1. 対象部門のエントリーチームのみをSupabaseから取得
        const { data: teams, error: tError } = await supabase
            .from('teams')
            .select('*')
            .eq('category', category);

        if (tError) return res.status(500).json({ error: tError.message });
        if (!teams || teams.length < 2) return res.status(400).json({ error: 'チーム数が足りません' });

        let matchesToInsert = [];

        // ==========================================
        // 📊 予選リーグの自動生成ロジック
        // ==========================================
        if (type === 'league') {
            const optimizedTeams = optimizeTeamDistribution(teams);
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

        // ==========================================
        // 🏆 公正な決勝トーナメント自動生成ロジック
        // ==========================================
        } else {
            const orgTeams = [...teams];
            const N = orgTeams.length;

            let T = 2;
            while (T < N) { T *= 2; }

            const numByes = T - N;

            let seedOrder = [0, 1];
            while (seedOrder.length < T) {
                const nextOrder = [];
                const currentLength = seedOrder.length;
                for (let i = 0; i < currentLength; i++) {
                    nextOrder.push(seedOrder[i]);
                    nextOrder.push(currentLength * 2 - 1 - seedOrder[i]);
                }
                seedOrder = nextOrder;
            }

            const sortedTeams = optimizeTeamDistribution(orgTeams);
            const slots = new Array(T).fill(null);

            const byeSlots = seedOrder
                .map((seed, index) => ({ seed, index }))
                .sort((a, b) => b.seed - a.seed)
                .slice(0, numByes)
                .map(item => item.index);

            let teamIdx = 0;
            for (let i = 0; i < T; i++) {
                if (byeSlots.includes(i)) {
                    slots[i] = { team_name: '（シード）', organization: '' };
                } else {
                    slots[i] = sortedTeams[teamIdx++];
                }
            }

            let matchNum = 1;
            for (let i = 0; i < T; i += 2) {
                const teamA = slots[i];
                const teamB = slots[i + 1];

                const isByeA = teamA.team_name === '（シード）';
                const isByeB = teamB.team_name === '（シード）';

                if (isByeA && isByeB) continue;

                let status = 'scheduled';
                let scoreA = 0;
                let scoreB = 0;

                if (isByeA || isByeB) {
                    status = 'finished';
                    scoreA = isByeB ? 1 : 0;
                    scoreB = isByeA ? 1 : 0;
                }

                matchesToInsert.push({
                    category,
                    stage: '決勝トーナメント',
                    title: `1回戦 第${matchNum}試合`,
                    teamA: teamA.team_name,
                    teamB: teamB.team_name,
                    scoreA,
                    scoreB,
                    status,
                    details: { 
                        round: 1, 
                        match_index: matchNum,
                        total_slots: T 
                    }
                });
                matchNum++;
            }
        }

        // --- 1. 既存データの安全な削除 ---
        const targetStage = type === 'league' ? '予選リーグ' : '決勝トーナメント';
        const { error: delError } = await supabase
            .from('matches')
            .delete()
            .eq('category', category)
            .eq('stage', targetStage);

        if (delError) {
            console.error(`[Generate Error] 既存の${targetStage}データの削除に失敗:`, delError);
            return res.status(500).json({ error: `既存データのクリーンアップ失敗: ${delError.message}` });
        }

        // --- 2. 一括インサートの堅牢化（エラー詳細のログ出力） ---
        console.log(`[Generate] ${category} (${targetStage}): ${matchesToInsert.length}件の試合データを送信します。`);
        
        const { data: insertedData, error: iError } = await supabase
            .from('matches')
            .insert(matchesToInsert)
            .select();

        if (iError) {
            console.error(`[Generate Error] ${targetStage}データの保存に失敗:`, iError);
            return res.status(500).json({ error: `試合データの保存に失敗しました: ${iError.message}` });
        }

        console.log(`[Generate Success] ${insertedData ? insertedData.length : 0}件の登録に成功しました。`);

        return res.json({ 
            success: true, 
            message: `${category} の${targetStage}（${matchesToInsert.length}試合）を正常に生成・上書きしました。` 
        });

    } catch (err) {
        console.error("生成処理内エラー:", err);
        return res.status(500).json({ error: err.message });
    }
});

// ＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝
// 🛡️ 同門（同一所属）のチームが近くにならないよう分散させる関数（ランダムシャッフル機能付き）
// ＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝─＝
function optimizeTeamDistribution(teams) {
    if (!teams || teams.length === 0) return [];
    
    // 💡 毎回異なる対戦表にするため、最初にチーム配列自体をランダムシャッフル
    const shuffledTeams = [...teams];
    for (let i = shuffledTeams.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledTeams[i], shuffledTeams[j]] = [shuffledTeams[j], shuffledTeams[i]];
    }

    // 所属（organization）ごとにグループ分け
    const groups = {};
    shuffledTeams.forEach(team => {
        const org = team.organization || '無所属';
        if (!groups[org]) groups[org] = [];
        groups[org].push(team);
    });

    // 所属ごとのチーム数の多い順にソート
    const sortedOrgs = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);

    const result = [];
    let added = true;

    // 各所属から1チームずつ順番に取り出してインターリーブ（交互に配置）する
    while (added) {
        added = false;
        for (const org of sortedOrgs) {
            if (groups[org].length > 0) {
                result.push(groups[org].shift());
                added = true;
            }
        }
    }

    return result;
}
// =================================================================
// 🚀 サーバー起動（待ち受け開始）の記述を追加
// =================================================================
app.listen(PORT, () => {
    console.log(`[🟢 Server Active] Tournament Manager is running on port ${PORT}`);
});
