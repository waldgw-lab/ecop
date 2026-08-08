INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('01e1791b-bd3b-49eb-895a-075e3a4f9ef7', 'UK billionaire Joe Lewis gets one...', 'https://www.bbc.com/news/articles/c740g7429l1o', 'POLICY', 'BBC News', 'Strategic military development with operational implications.', '2025-11-14T00:52:45.276Z', NULL, 0, '{}', 'uk billionaire joe lewis gets one', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('09137d66-9e6e-4d18-9515-c3b1ee602b0b', 'Foreclosures surge 20%...', 'https://www.dailymail.co.uk/real-estate/article-15285273/foreclosures-october-financial-crash.html', 'DOMESTIC', 'Dailymail', 'Strategic military development with operational implications.', '2025-11-13T14:51:30.699Z', NULL, 0, '{}', 'foreclosures surge 20', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('14166cf7-8ac0-4cb8-a077-0378a9c69505', 'Russian military spy ship tracked just 15 miles off Hawaii coast!', 'https://www.cbsnews.com/news/russian-military-spy-ship-hawaii-us-coast-guard/', 'GLOBAL', 'Cbsnews', 'Strategic military development with operational implications.', '2025-11-14T18:08:27.984Z', '2025-11-14T16:12:15.000Z', 0, '{}', 'russian military spy ship tracked just 15 miles off hawaii coast', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('22a7b22b-bc3e-4624-a658-efb304b70286', 'Internet Freedom Declines In USA, Germany...', 'https://www.barrons.com/news/internet-freedom-declines-in-us-germany-study-81fdd752', 'POLICY', 'Barrons', 'Strategic military development with operational implications.', '2025-11-13T13:57:06.372Z', '2025-11-13T05:01:00.000Z', 0, '{}', 'internet freedom declines in usa germany', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('22cf5503-00e9-4c35-b42f-d04901e6c539', 'Pentagon Pete Rants About ''Beardos'' Again During Wild Military Speech...', 'https://archive.is/q071q', 'POLICY', 'Archive', 'Strategic military development with operational implications.', '2025-11-12T22:57:10.531Z', NULL, 0, '{}', 'pentagon pete rants about beardos again during wild military speech', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('23619799-7787-426f-ae73-f48251cf8129', 'Judge orders release of over 300 ''Operation Midway Blitz'' detainees...', 'https://www.politico.com/news/2025/11/12/judge-operation-midway-blitz-chicago-ice-00649104', 'POLICY', 'Politico', 'Strategic military development with operational implications.', '2025-11-13T19:54:26.841Z', NULL, 0, '{}', 'judge orders release of over 300 operation midway blitz detainees', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('27505c83-98d7-4920-9d58-9c562ebc6317', 'Nancy Mace Risks Support for SC Gov Endorsement...', 'https://www.notus.org/donald-trump/nancy-mace-epstein-petition-south-carolina-governor', 'POLICY', 'Notus', 'Strategic military development with operational implications.', '2025-11-13T21:51:41.972Z', NULL, 0, '{}', 'nancy mace risks support for sc gov endorsement', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('27eb61b4-705b-4309-ae6b-e55a7342dad8', 'Gov. Pritzker Warns Trump Will ''Take Us to War With Venezuela'' to Distract From Epstein...', 'https://www.commondreams.org/news/trump-epstein-distraction ', 'POLICY', 'Commondreams', 'Regional conflict updates and military engagement developments.', '2025-11-14T16:53:57.957Z', '2025-11-13T17:31:26.000Z', 0, '{}', 'gov pritzker warns trump will take us to war with venezuela to distract from epstein', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('38679220-ebb5-4314-bf53-45823f8612fc', 'Trump Org requested record number of foreign workers in 2025...', 'https://thehill.com/business/5603478-trump-organization-foreign-workers-2025/', 'POLICY', 'The Hill', 'Strategic military development with operational implications.', '2025-11-13T14:03:46.240Z', NULL, 0, '{}', 'trump org requested record number of foreign workers in 2025', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('4ff4a03e-f23f-4611-81f5-a823266b11da', 'Canadian Travel to USA Declines for 10th Straight Month...', 'https://www.nytimes.com/2025/11/13/us/canada-us-travel-decline-flights.html?unlocked_article_code=1.008.r-kd.IDnvKoW9Agra&smid=url-share', 'DOMESTIC', 'The New York Times', 'Strategic military development with operational implications.', '2025-11-13T14:01:58.242Z', NULL, 0, '{}', 'canadian travel to usa declines for 10th straight month', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('53219c1e-bc10-48a1-b49c-aa1ef7757941', 'LAMER DUCK THAN EVER...', 'https://www.theatlantic.com/politics/2025/11/trump-lame-duck-third-term-prospects/684899/', 'POLICY', 'Theatlantic', 'Strategic military development with operational implications.', '2025-11-13T13:02:03.493Z', '2025-11-12T15:16:47.000Z', 0, '{}', 'lamer duck than ever', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('5f8e9307-dc94-4c34-862f-b2b08fa35bc3', 'Memo Blessing Boat Strikes Is Said to Rely on Trump Claims About Cartels...', 'https://www.nytimes.com/2025/11/13/us/politics/boat-strikes-doj-memo-trump.html?unlocked_article_code=1.1E8.6IQk.K9lufGZjxzfo&smid=url-share', 'POLICY', 'The New York Times', 'Strategic military development with operational implications.', '2025-11-14T12:07:45.313Z', NULL, 0, '{}', 'memo blessing boat strikes is said to rely on trump claims about cartels', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('684a6c4f-da0e-4a8b-b029-8ebbc3d087e3', 'Colombia''s president lashes out at ''barbarian'' Trump over boat attacks...', 'https://www.nbcnews.com/world/rcna243530', 'GLOBAL', 'Nbcnews', 'Strategic military development with operational implications.', '2025-11-13T13:11:28.962Z', '2025-11-13T12:56:37.621Z', 0, '{}', 'colombia s president lashes out at barbarian trump over boat attacks', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('6db339ed-ff30-4a90-9b90-607798e98410', 'Official refers Swalwell for federal criminal probe over alleged mortgage fraud...', 'https://www.nbcnews.com/politics/rcna243518', 'POLICY', 'Nbcnews', 'Strategic military development with operational implications.', '2025-11-13T19:13:34.594Z', '2025-11-13T18:52:21.808Z', 0, '{}', 'official refers swalwell for federal criminal probe over alleged mortgage fraud', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('789e071b-8074-4af7-a747-6ffdf95b6cd6', 'Boebert Raises Eyebrows With Post After Trump Pressure on Epstein Files Vote...', 'https://www.msn.com/en-us/politics/government/ar-AA1QnsRd', 'POLICY', 'Archive', 'Strategic military development with operational implications.', '2025-11-13T15:42:17.942Z', NULL, 0, '{}', 'boebert raises eyebrows with post after trump pressure on epstein files vote', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('7d95746c-bfbc-405f-bb5c-f2dfd050a9cb', 'Top officials present Trump with military options for Venezuela...', 'https://www.cbsnews.com/news/trump-venezuela-military-options/', 'POLICY', 'Cbsnews', 'Strategic military development with operational implications.', '2025-11-14T11:48:40.019Z', '2025-11-14T00:23:19.000Z', 0, '{}', 'top officials present trump with military options for venezuela', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('81f8336e-2659-40e2-ad61-f77723c36b4d', 'New rare earth crisis brewing as yttrium shortages spread...', 'https://archive.is/mmbjE', 'DOMESTIC', 'Archive', 'Strategic military development with operational implications.', '2025-11-14T18:43:12.124Z', NULL, 0, '{}', 'new rare earth crisis brewing as yttrium shortages spread', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('85bfe5ec-76f0-4cc2-be38-6da893d36018', 'TRUMP FACES REPUBLICAN REBELLION', 'https://www.telegraph.co.uk/world-news/2025/11/13/trump-faces-biggest-republican-rebellion-over-epstein/', 'POLICY', 'Telegraph', 'Strategic military development with operational implications.', '2025-11-13T13:57:04.551Z', NULL, 0, '{}', 'trump faces republican rebellion', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('86007d8b-f855-40c3-905d-f5b48089b3ce', 'Russia Pummels Kyiv as It Torments Ukrainian Civilians...', 'https://www.nytimes.com/2025/11/14/world/europe/ukraine-kyiv-russia-strike.html?unlocked_article_code=1.1E8.v0Fx.u0riiXp9eVCj&smid=url-share', 'GLOBAL', 'The New York Times', 'Strategic military development with operational implications.', '2025-11-14T14:51:25.094Z', NULL, 0, '{}', 'russia pummels kyiv as it torments ukrainian civilians', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('88083cd4-3433-40c3-a846-76bd786c40c7', 'BLUE ORIGIN lands huge New Glenn rocket booster for 1st time...', 'https://www.space.com/space-exploration/launches-spacecraft/blue-origin-lands-huge-new-glenn-rocket-booster-for-1st-time-after-acing-mars-escapade-launch-for-nasa', 'INTEL', 'Space', 'Strategic military development with operational implications.', '2025-11-13T22:51:37.871Z', NULL, 0, '{}', 'blue origin lands huge new glenn rocket booster for 1st time', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('8d8f1a16-ee1b-49d2-a4d4-1a72db87a401', 'Tehran taps run dry as water crisis deepens...', 'https://www.jpost.com/middle-east/article-873638', 'GLOBAL', 'Jpost', 'Strategic military development with operational implications.', '2025-11-12T20:19:20.310Z', '2025-11-12T17:14:47.000Z', 0, '{}', 'tehran taps run dry as water crisis deepens', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('9797e908-a708-4248-8ec4-55816db40e6a', 'California Campaign to Intro First-of-Its-Kind Billionaire''s Tax...', 'https://www.wsj.com/business/california-billionaire-wealth-tax-7f2f8f2e', 'POLICY', 'The Wall Street Journal', 'Strategic military development with operational implications.', '2025-11-13T21:51:39.572Z', NULL, 0, '{}', 'california campaign to intro first of its kind billionaire s tax', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('97a6469c-6c19-4364-93ea-99ea599504f6', 'UPDATE: Summoned to Situaton Room!', 'https://www.cnn.com/2025/11/12/politics/trump-administration-meeting-house-effort-epstein-document-release', 'POLICY', 'CNN', 'Strategic military development with operational implications.', '2025-11-13T23:41:42.973Z', NULL, 0, '{}', 'update summoned to situaton room', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('a0373847-abbe-43cd-8fa5-e45f3cec8b4e', 'High stakes hearing as Comey and James seek to disqualify prosecutor...', 'https://www.msn.com/en-us/politics/government/high-stakes-hearing-as-comey-and-james-seek-to-disqualify-prosecutor/ar-AA1Qmbkf', 'POLICY', 'Msn', 'Strategic military development with operational implications.', '2025-11-13T13:57:05.535Z', NULL, 0, '{}', 'high stakes hearing as comey and james seek to disqualify prosecutor', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('a9fa9288-8830-4464-af17-7aaacfeeda9c', 'Administration targets worker for TV interview about SNAP impacts...', 'https://www.msn.com/en-us/news/politics/trump-administration-targets-worker-for-tv-interview-about-snap-impacts/ar-AA1Qmifb', 'POLICY', 'Msn', 'Strategic military development with operational implications.', '2025-11-13T14:03:45.886Z', NULL, 0, '{}', 'administration targets worker for tv interview about snap impacts', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('b6a4d5a3-8426-45c0-9198-45f47cf27c74', 'New supercarrier challenges U.S. dominance in Pacific...', 'https://archive.ph/f43ED', 'GLOBAL', 'Archive', 'Strategic military development with operational implications.', '2025-11-14T12:36:37.415Z', NULL, 0, '{}', 'new supercarrier challenges u s dominance in pacific', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('ba445b2b-7bad-468f-a845-25965d51e5f2', 'SHOCK POLL:  ONLY 33% APPROVE OF TRUMP''S MANAGEMENT OF GOVT...', 'https://apnews.com/9daa3f130fedc9cf9b5acf3de31e93f4', 'POLICY', 'Associated Press', 'Strategic military development with operational implications.', '2025-11-13T14:03:44.995Z', '2025-11-12T16:22:50.000Z', 0, '{}', 'shock poll only 33 approve of trump s management of govt', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('c1645872-91a8-4adb-bd29-d5857a462623', 'White House goes over Venezuela land strike plans...', 'https://www.cbsnews.com/news/trump-venezuela-military-options/', 'GLOBAL', 'Cbsnews', 'Strategic military development with operational implications.', '2025-11-13T19:44:34.765Z', '2025-11-13T17:24:47.000Z', 0, '{}', 'white house goes over venezuela land strike plans', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('cb66d4b6-f7fa-460d-a4fd-27a3019639e2', 'Terrifying-Looking Robot Powers Up, Immediately Declares Humanity ''Resource'' to Be ''Manipulated or Eliminated''...', 'https://www.msn.com/en-us/news/technology/ar-AA1QosIi', 'INTEL', 'Msn', 'Strategic military development with operational implications.', '2025-11-13T22:31:39.771Z', NULL, 0, '{}', 'terrifying looking robot powers up immediately declares humanity resource to be manipulated or eliminated', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('ce9d48bb-7086-459c-9f49-d84e507e6716', 'Trump Summons Boebert as He Pushes GOP to Block Epstein Vote...', 'https://www.nytimes.com/2025/11/12/us/politics/trump-epstein-vote-boebert.html?unlocked_article_code=1.0k8.dHoM.YIYBLFzFwP5w&smid=url-share', 'POLICY', 'The New York Times', 'Strategic military development with operational implications.', '2025-11-13T11:55:43.164Z', NULL, 0, '{}', 'trump summons boebert as he pushes gop to block epstein vote', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('d3886e59-3e72-4cc8-ab4b-a51317b42257', 'October jobs and inflation data may NEVER be released...', 'https://www.cnbc.com/2025/11/12/white-house-october-data-release.html', 'DOMESTIC', 'Cnbc', 'Strategic military development with operational implications.', '2025-11-13T14:02:01.432Z', NULL, 0, '{}', 'october jobs and inflation data may never be released', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('d694e55b-f4ff-45da-84be-e5980ad59415', 'Israeli Settlers Burn Mosque as West Bank Violence Escalates...', 'https://www.wsj.com/world/middle-east/israeli-settlers-burn-mosque-as-west-bank-violence-escalates-82aa44fc', 'GLOBAL', 'The Wall Street Journal', 'Strategic military development with operational implications.', '2025-11-14T14:51:27.396Z', NULL, 0, '{}', 'israeli settlers burn mosque as west bank violence escalates', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('d9b0fd21-9513-419f-9bf0-491b7fd6dd51', 'GALLUP: Record Numbers of Younger Women Want to Flee America...', 'https://news.gallup.com/poll/697382/record-numbers-younger-women-leave.aspx', 'POLICY', 'News', 'Strategic military development with operational implications.', '2025-11-13T15:13:26.061Z', '2025-11-13T00:00:00.000Z', 0, '{}', 'gallup record numbers of younger women want to flee america', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('e1e74f46-9b5b-4b0a-a7f5-98c02a305342', 'UK billionaire Joe Lewis receives pardon...', 'https://www.bbc.com/news/articles/c740g7429l1o', 'POLICY', 'BBC News', 'Strategic military development with operational implications.', '2025-11-13T21:51:44.072Z', NULL, 0, '{}', 'uk billionaire joe lewis receives pardon', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('e4057360-db1e-4733-9988-c395f83c084d', 'The Luxury Electric Vehicle Is in Trouble...', 'https://www.nytimes.com/2025/11/13/business/luxury-electric-vehicles.html?unlocked_article_code=1.008.4BZG.eTqqDptrBa8t&smid=url-share', 'DOMESTIC', 'The New York Times', 'Strategic military development with operational implications.', '2025-11-13T15:13:26.717Z', NULL, 0, '{}', 'the luxury electric vehicle is in trouble', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('e9aa4ccd-3f90-4552-85f5-c7d7fee2a884', 'Kash Patel Girlfriend Driving MAGA Nuts...', 'https://www.thebulwark.com/p/kash-patel-girlfriend-alexis-wilkins-driving-maga-nuts', 'POLICY', 'Thebulwark', 'Strategic military development with operational implications.', '2025-11-13T21:51:44.972Z', NULL, 0, '{}', 'kash patel girlfriend driving maga nuts', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('f7aa2005-6bb0-42fb-88c5-1857f6b915b1', 'Germany calls up all men aged 18 for military exam...', 'https://www.thetimes.com/world/europe/article/germany-military-service-conscription-zzphth5ts', 'DEFENSE', 'Thetimes', 'Strategic military development with operational implications.', '2025-11-13T17:53:16.476Z', '2025-11-13T10:54:00.000Z', 0, '{}', 'germany calls up all men aged 18 for military exam', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;

INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('fd9229d9-672d-48f7-9f01-5ecd0a6a7860', 'Judge appears skeptical of DOJ arguments for keeping prosecutor in Comey, James cases...', 'https://www.nbcnews.com/politics/rcna243270', 'POLICY', 'Nbcnews', 'Strategic military development with operational implications.', '2025-11-13T19:13:34.793Z', '2025-11-13T17:48:48.028Z', 0, '{}', 'judge appears skeptical of doj arguments for keeping prosecutor in comey james cases', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;