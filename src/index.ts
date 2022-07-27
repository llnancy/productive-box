import { resolve } from 'path';
import { config } from 'dotenv';
import { Octokit } from '@octokit/rest';

import githubQuery from './githubQuery';
import generateBarChart from './generateBarChart';
import { userInfoQuery, createContributedRepoQuery, createCommittedDateQuery } from './queries';

const fs = require('fs');

/**
 * get environment variable
 */
config({ path: resolve(__dirname, '../.env') });

const {
  PRODUCTIVE_GIST_ID: gistId,
  GH_TOKEN: githubToken,
  TIMEZONE: timeZone,
  MARKDOWN_FILE: markdownFile,
  PRODUCTIVE_START_TAG: startTag,
  PRODUCTIVE_END_TAG: endTag,
} = process.env;

interface IRepo {
  name: string;
  owner: string;
}

(async() => {
  /**
   * First, get user id
   */
  const userResponse = await githubQuery(userInfoQuery)
    .catch(error => console.error(`Unable to get username and id\n${error}`));
  const { login: username, id } = userResponse?.data?.viewer;

  /**
   * Second, get contributed repos
   */
  const contributedRepoQuery = createContributedRepoQuery(username);
  const repoResponse = await githubQuery(contributedRepoQuery)
    .catch(error => console.error(`Unable to get the contributed repo\n${error}`));
  const repos: IRepo[] = repoResponse?.data?.user?.repositoriesContributedTo?.nodes
    .filter(repoInfo => (!repoInfo?.isFork))
    .map(repoInfo => ({
      name: repoInfo?.name,
      owner: repoInfo?.owner?.login,
    }));

  /**
   * Third, get commit time and parse into commit-time/hour diagram
   */
  const committedTimeResponseMap = await Promise.all(
    repos.map(({name, owner}) => githubQuery(createCommittedDateQuery(id, name, owner)))
  ).catch(error => console.error(`Unable to get the commit info\n${error}`));

  if (!committedTimeResponseMap) return;

  let morning = 0; // 6 - 12
  let daytime = 0; // 12 - 18
  let evening = 0; // 18 - 24
  let night = 0; // 0 - 6

  committedTimeResponseMap.forEach(committedTimeResponse => {
    committedTimeResponse?.data?.repository?.defaultBranchRef?.target?.history?.edges.forEach(edge => {
      const committedDate = edge?.node?.committedDate;
      const timeString = new Date(committedDate).toLocaleTimeString('en-US', { hour12: false, timeZone: timeZone });
      const hour = +(timeString.split(':')[0]);

      /**
       * voting and counting
       */
      if (hour >= 6 && hour < 12) morning++;
      if (hour >= 12 && hour < 18) daytime++;
      if (hour >= 18 && hour < 24) evening++;
      if (hour >= 0 && hour < 6) night++;
    });
  });

  /**
   * Next, generate diagram
   */
  const sum = morning + daytime + evening + night;
  if (!sum) return;

  const oneDay = [
    { label: '🌞 早晨', commits: morning },
    { label: '🌆 白天', commits: daytime },
    { label: '🌃 晚上', commits: evening },
    { label: '🌙 深夜', commits: night },
  ];

  const lines = oneDay.reduce((prev, cur) => {
    const percent = cur.commits / sum * 100;
    const line = [
      `${cur.label}`.padEnd(6),
      `${cur.commits.toString().padStart(5)} commits`.padEnd(14),
      generateBarChart(percent, 21),
      String(percent.toFixed(1)).padStart(5) + '%',
    ];

    return [...prev, line.join(' ')];
  }, []);

  /**
   * Finally, write into gist
   */
  const octokit = new Octokit({ auth: `token ${githubToken}` });
  const gist = await octokit.gists.get({
    gist_id: gistId
  }).catch(error => console.error(`Unable to update gist\n${error}`));
  if (!gist) return;

  const filename = Object.keys(gist.data.files)[0];
  const title = (morning + daytime) > (evening + night) ? '我通常在日间工作 🐤' : '我通常在夜晚工作 🦉';
  await octokit.gists.update({
    gist_id: gistId,
    files: {
      [filename]: {
        // eslint-disable-next-line quotes
        filename: title,
        content: lines.join('\n'),
      },
    },
  });

  // write to markdown
  const start = startTag ?? '<!-- productive-box start -->';
  const end = endTag ?? '<!-- productive-box end -->';
  const markdownTitle = `\n#### <a href="https://gist.github.com/${gistId}" target="_blank">${title}</a>\n`;
  const markdownContent = lines.join('\n');
  if (markdownFile) {
    fs.readFile(markdownFile, 'utf8' , (err, data) => {
      if (err) {
        console.error(err);
        return;
      }
      const startIndex = data.indexOf(start) + start.length;
      const endIndex = data.indexOf(end);
      const markdown = data.substring(0, startIndex) + markdownTitle + '```text\n' + markdownContent + '\n```\n' + data.substring(endIndex);
      console.log(markdown);
      fs.writeFile(markdownFile, markdown, err => {
        if (err) {
          console.error(err);
          return;
        }
      });
    });
  }
})();
