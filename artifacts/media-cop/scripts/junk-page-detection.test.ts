/**
 * Gate: junk-page-detection
 *
 * Verifies isJunkPageContent() correctly intercepts junk pages (browser-compat
 * notices, captcha/bot walls, non-Latin-dominant shells, nav-menus, footer
 * boilerplate) before they reach the AI summarizer, while never flagging real
 * English article text.
 *
 * Pure deterministic — no DB, no network, no AI. Exit 0 = pass, 1 = fail.
 */

import { isJunkPageContent } from '../server/textScraper';

let passed = 0;
let failed = 0;

function assertJunk(label: string, text: string) {
  if (isJunkPageContent(text)) {
    console.log(`  PASS  flagged (junk): "${label}"`);
    passed++;
  } else {
    console.error(`  FAIL  NOT flagged but should be (junk): "${label}"`);
    failed++;
  }
}

function assertClean(label: string, text: string) {
  if (!isJunkPageContent(text)) {
    console.log(`  PASS  not flagged (clean): "${label}"`);
    passed++;
  } else {
    console.error(`  FAIL  wrongly flagged (false positive): "${label}"`);
    failed++;
  }
}

console.log('\nJunk positives — browser-compat / JS-required notices:');

assertJunk(
  'standard JS-required notice',
  'Please enable JavaScript to view this website. This site requires JavaScript to function properly.',
);
assertJunk(
  'enable JavaScript and cookies',
  'JavaScript must be enabled in your browser to continue. Please also allow cookies from this site.',
);
assertJunk(
  'browser not supported',
  'Your browser is not supported. Please upgrade to a modern browser that supports JavaScript.',
);
assertJunk(
  'noscript fallback',
  'This website requires JavaScript. Please enable JavaScript in your browser settings and reload the page.',
);

console.log('\nJunk positives — captcha / bot-wall pages:');

assertJunk(
  'Cloudflare challenge page',
  'Checking if the site connection is secure. Cloudflare is checking your browser before access is granted to this website.',
);
assertJunk(
  'CAPTCHA gate',
  'Please complete the CAPTCHA verification below to prove you are not a robot and continue to the site.',
);
assertJunk(
  'DDoS protection interstitial',
  'DDoS protection by Cloudflare. Performance and security by Cloudflare. Ray ID: abc123def456.',
);

console.log('\nJunk positives — non-Latin-dominant pages:');

assertJunk(
  'predominantly Persian text',
  'خبرگزاری فارس — آخرین اخبار ایران و جهان. رویدادهای سیاسی، اجتماعی، ورزشی و فرهنگی. اقتصاد و بازار سرمایه ایران.',
);
assertJunk(
  'predominantly Arabic text',
  'الجزيرة نت — آخر الأخبار والتحليلات السياسية. الشرق الأوسط وأفريقيا. أخبار دولية وتغطيات مباشرة.',
);
assertJunk(
  'predominantly CJK text',
  '新华社北京7月15日电 据中国国防部发布消息，解放军东部战区今日在台湾海峡举行联合演习，持续时间约三天，演习区域覆盖台岛北部及东部海域。',
);

console.log('\nJunk positives — navigation menus (Latin-script):');

assertJunk(
  'Xinhua English nav bar',
  'Home\nPolitics\nEconomy\nSociety\nCulture\nScience\nEducation\nSports\nEntertainment\nOpinion\nPhoto\nVideo\nWorld\nBusiness\nTech\nHealth',
);
assertJunk(
  'pipe-separated section nav',
  'Home | World | Politics | Business | Technology | Sports | Entertainment | Health | Science | Arts | Travel | Opinion | Video',
);
assertJunk(
  'bullet-separated link list',
  'Breaking News • World News • U.S. News • Politics • Business • Tech • Health • Science • Entertainment • Sports • Travel • Weather',
);
assertJunk(
  'CNBC section headers',
  'Markets\nBusiness\nInvesting\nTech\nPolitics\nWorld\nHealth\nMedia\nReal Estate\nEnergy\nClimate\nLife\nSmall Business\nPersonal Finance\nWealth',
);

console.log('\nJunk positives — footer boilerplate:');

assertJunk(
  'cookie consent + legal footer',
  'Privacy Policy | Terms of Service | Cookie Notice | All Rights Reserved 2025 | Advertise with us | Accessibility Statement',
);
assertJunk(
  'GDPR consent page',
  'We use cookies to improve your experience. Cookie Policy. Privacy Policy. Terms of Use. Do not sell my personal information. Newsletter sign-up.',
);
assertJunk(
  'dense legal footer',
  'Cookie Settings. Privacy Policy. Terms of Service. Advertise with us. Accessibility Statement. All rights reserved.',
);

console.log('\nClean negatives — real article text must NOT be flagged:');

assertClean(
  'standard defense article',
  'Iran launched over 300 drones and missiles at Israel in the overnight attack, the largest direct assault since the two countries began their shadow conflict. U.S. and allied forces intercepted the majority of the projectiles before they crossed into Israeli airspace.',
);
assertClean(
  'article quoting Arabic names',
  'The commander, identified as Abu Mohammad al-Jawlani, confirmed in a statement that forces had seized the border crossing. The group, known in Arabic as Hayat Tahrir al-Sham, controls much of northwestern Syria.',
);
assertClean(
  'article with CJK proper noun',
  "China's People's Liberation Army announced the exercise near Taiwan. The PLA Navy, or 解放军海军, deployed three carrier strike groups in an unprecedented show of force.",
);
assertClean(
  'article with privacy-policy reference in prose',
  'The administration released a privacy policy review covering data collected by intelligence agencies. The terms of use for classified databases came under scrutiny after the leak.',
);
assertClean(
  'article with cookie mention in news context',
  'Regulators said they would enforce the cookie consent rules under the EU\'s General Data Protection Regulation starting next quarter.',
);
assertClean(
  'article with contact/about reference',
  'Officials said to contact the defense attaché office directly. About 3,000 troops have been pre-positioned at the base since January.',
);
assertClean(
  'article with "all rights" in a legal context',
  'The court ruled that intellectual property rights reserved under the treaty apply to dual-use technology. All rights to appeal were exhausted by the defendant.',
);
assertClean(
  'article with pipe in dateline',
  'WASHINGTON | Senior officials confirmed Friday that a second carrier strike group has entered the Persian Gulf in response to escalating tensions with Iran.',
);
assertClean(
  'article with slash in unit name',
  'The F/A-18E/F Super Hornet squadrons aboard USS Dwight D. Eisenhower conducted strike missions throughout the night, officials confirmed Monday morning.',
);
assertClean(
  'short but clean excerpt',
  'NATO members agreed to raise defense spending to 5 percent of GDP.',
);
assertClean(
  'empty string',
  '',
);
assertClean(
  'whitespace only',
  '   \n\t  ',
);
assertClean(
  'article with multiple newlines (not nav menu)',
  'The Pentagon confirmed the exercise Friday.\n\nOfficials said operations would continue for 72 hours.\n\nDefense Secretary Lloyd Austin is expected to brief Congress on Monday.\n\nAllied forces from six nations are participating in the drill off the coast of Guam.',
);
assertClean(
  'article with bullet-point dateline lines (>3 words each)',
  'Key developments from the briefing:\n- The second infantry division has been repositioned north of Seoul\n- Air defense batteries are now operational at three forward bases\n- Naval assets remain on heightened alert in the Yellow Sea\n- No civilian evacuation orders have been issued at this time',
);

console.log('');
if (failed > 0) {
  console.error(`${failed} check(s) FAILED`);
  process.exit(1);
} else {
  console.log(`All ${passed} junk-page detection checks passed`);
  process.exit(0);
}
