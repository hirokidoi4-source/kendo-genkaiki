// // // require('dotenv').config();
const path = require('path');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const PORT = process.env.PORT || 3000;

// Supabase接続設定
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 試合結果取得
app.get('/api/matches', async (req, res) => {
    const { data, error } = await supabase.from('matches').select('*').order('id', { ascending: false });
    res.json(data || []);
});

// 試合結果保存
app.post('/api/match', async (req, res) => {
    try {
        const { category, stage, title, teamA, teamB, scoreA, scoreB, status, details } = req.body;
        const parsedDetails = typeof details === 'string' ? JSON.parse(details) : details;

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
                status,
                details: parsedDetails
            }]);

        if (error) {
            console.error("Supabase保存エラー:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true });
    } catch (err) {
        console.error("サーバーエラー:", err);
        res.status(500).json({ error: err.message });
    }
});

// 【決勝勝ち上がり自動生成付き】試合結果を「更新」または「新規保存」するAPI
app.post('/api/match_update', async (req, res) => {
    try {
        const { id, category, stage, title, teamA, teamB, scoreA, scoreB, status, details } = req.body;
        const parsedDetails = typeof details === 'string' ? JSON.parse(details) : details;

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
    const rawTeams = req.body;
    if (!Array.isArray(rawTeams)) return res.status(400).json({ error: 'Invalid data format' });

    const categoryMap = {
        '小学生低学年': 'low_elem',
        '小学生団体': 'elem',
        '中学生団体': 'mid',
        '中学女子団体': 'mid_girls'
    };

    const cleanedTeams = rawTeams.map(team => ({
        category: categoryMap[team.category] || team.category,
        team_name: team.team_name,
        organization: team.organization
    }));

    try {
        const { error: dError } = await supabase.from('teams').delete().neq('id', 0);
        if (dError) throw dError;

        const { data, error: iError } = await supabase.from('teams').insert(cleanedTeams);
        if (iError) throw iError;

        res.json({ success: true, count: cleanedTeams.length });
    } catch (err) {
        console.error("Supabaseインポート/クリアエラー:", err);
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/tournament/generate', async (req, res) => {
    const { category, type } = req.body;
    try {
        const { data: teams, error: tError } = await supabase.from('teams').select('*').eq('category', category);
        if (tError) return res.status(500).json({ error: tError.message });
        if (!teams || teams.length < 2) return res.status(400).json({ error: 'チーム数が足りません' });

        const optimizedTeams = optimizeTeamDistribution(teams);
        let matchesToInsert = [];

        if (type === 'league') {
            const groupCount = Math.ceil(optimizedTeams.length / 3);
            const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
            
            const getGroupName = (index) => {
                if (index < 26) return `${alphabet[index]}リーグ`;
                const firstChar = alphabet[Math.floor(index / 26) - 1];
                const secondChar = alphabet[index % 26];
                return `${firstChar}${secondChar}リーグ`;
            };

            for (let g = 0; g < groupCount; g++) {
                const groupName = getGroupName(g);
                const curLeagueTeams = optimizedTeams.slice(g * 3, g * 3 + 3);

                while (curLeagueTeams.length < 3) {
                    curLeagueTeams.push({ team_name: '（不戦勝枠）', organization: 'なし' });
                }

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
                            details: { same_org: isSameOrg, league: groupName, round: matchCount }
                        });
                        matchCount++;
                    }
                }
            }
        } else {
            for (let i = 0; i < optimizedTeams.length; i += 2) {
                const teamA = optimizedTeams[i];
                const teamB = optimizedTeams[i + 1] || { team_name: '（シード）', organization: '' };
                
                matchesToInsert.push({
                    category,
                    stage: '決勝トーナメント',
                    title: `1回戦 第${Math.floor(i/2) + 1}試合`,
                    teamA: teamA.team_name,
                    teamB: teamB.team_name,
                    scoreA: 0,
                    scoreB: 0,
                    status: teamB.team_name === '（シード）' ? 'finished' : 'scheduled',
                    details: { round: 1, match_index: Math.floor(i/2) }
                });
            }
        }

        if (type === 'league') {
            await supabase.from('matches').delete().eq('category', category).eq('stage', '予選リーグ');
        } else {
            await supabase.from('matches').delete().eq('category', category).eq('stage', '決勝トーナメント');
        }

        const { error: iError } = await supabase.from('matches').insert(matchesToInsert);
        if (iError) return res.status(500).json({ error: iError.message });

        res.json({ success: true, message: `${matchesToInsert.length}個の対戦カードを生成・反映しました。` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tournament/save_league', async (req, res) => {
    const { category, matches } = req.body;
    try {
        await supabase.from('matches').delete().eq('category', category).eq('stage', '予選リーグ');
        const { error } = await supabase.from('matches').insert(matches);
        if (error) throw error;
        res.json({ success: true, count: matches.length });
    } catch (err) {
        console.error("保存エラー:", err);
        res.status(500).json({ error: err.message });
    }
});

function optimizeTeamDistribution(teams) {
    const orgGroups = {};
    teams.forEach(team => {
        if (!orgGroups[team.organization]) orgGroups[team.organization] = [];
        orgGroups[team.organization].push(team);
    });
    const sortedOrgs = Object.keys(orgGroups).sort((a, b) => orgGroups[b].length - orgGroups[a].length);
    const result = [];
    let hasMore = true;
    while (hasMore) {
        hasMore = false;
        for (const org of sortedOrgs) {
            if (orgGroups[org].length > 0) {
                result.push(orgGroups[org].shift());
                hasMore = true;
            }
        }
    }
    return result;
}

app.post('/api/tournament/save_final', async (req, res) => {
    const { category, matches } = req.body;
    try {
        await supabase.from('matches').delete().eq('category', category).eq('stage', '決勝トーナメント');
        const { error } = await supabase.from('matches').insert(matches);
        if (error) throw error;
        res.json({ success: true, count: matches.length });
    } catch (err) {
        console.error("保存エラー:", err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Supabase接続完了！本番モードで起動中: http://localhost:${PORT}`);
});
