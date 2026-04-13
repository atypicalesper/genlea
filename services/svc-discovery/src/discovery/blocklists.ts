import type { ScraperSource, Scraper } from '@genlea/shared';
import {
  linkedInScraper, apolloScraper, crunchbaseScraper, wellfoundScraper,
  indeedScraper, glassdoorScraper, surelyRemoteScraper, exploriumScraper,
  zoomInfoScraper, clayScraper,
} from '../scrapers/index.js';

export const SCRAPERS: Record<string, Scraper> = {
  explorium:    exploriumScraper,
  wellfound:    wellfoundScraper,
  linkedin:     linkedInScraper,
  indeed:       indeedScraper,
  crunchbase:   crunchbaseScraper,
  apollo:       apolloScraper,
  glassdoor:    glassdoorScraper,
  surelyremote: surelyRemoteScraper,
  zoominfo:     zoomInfoScraper,
  clay:         clayScraper,
};

export const BLOCKED_DOMAINS = new Set<string>([
  'example.com','example.org','example.net','test.com','localhost',
  'google.com','amazon.com','microsoft.com','apple.com','meta.com','facebook.com',
  'netflix.com','salesforce.com','oracle.com','ibm.com','sap.com','adobe.com',
  'intuit.com','paypal.com','ebay.com','uber.com','lyft.com','airbnb.com',
  'twitter.com','x.com','linkedin.com','snap.com','pinterest.com','reddit.com',
  'discord.com','shopify.com','squarespace.com','wix.com','hubspot.com','zendesk.com',
  'atlassian.com','slack.com','zoom.us','dropbox.com','box.com','twilio.com',
  'cloudflare.com','okta.com','datadog.com','splunk.com','crowdstrike.com',
  'pagerduty.com','hashicorp.com','confluent.io','stripe.com','plaid.com',
  'braintree.com','square.com','jpmorganchase.com','jpmorgan.com','chase.com',
  'bankofamerica.com','wellsfargo.com','citigroup.com','goldmansachs.com',
  'morganstanley.com','deloitte.com','pwc.com','kpmg.com','ey.com','accenture.com',
  'infosys.com','tcs.com','wipro.com','cognizant.com','walmart.com','target.com',
]);

export const BLOCKED_NAME_PATTERNS: RegExp[] = [
  /\bbank\b/i, /\bchase\b/i, /\bmorgan\b/i, /\bfinancial\b/i,
  /\binsurance\b/i, /\bhospital\b/i, /\bhealthcare\b/i,
  /\bdeloitte\b/i, /\baccenture\b/i, /\bcognizant\b/i,
  /\bgovernment\b/i, /\bfederal\b/i, /\bdepartment of\b/i,
];

export function isJunkDomain(domain: string): boolean {
  if (!domain.includes('.')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) return true;
  const tld = domain.split('.').at(-1)!;
  return tld.length > 6;
}
