export type InfluencerXAccount = {
  id: string;
  label: string;
};

export const INFLUENCER_X_ACCOUNTS: InfluencerXAccount[] = [
  { id: 'AndrewKolvet', label: '@AndrewKolvet' },
  { id: 'libsoftiktok', label: '@libsoftiktok' },
  { id: 'JackPosobiec', label: '@JackPosobiec' },
  { id: 'EndWokeness', label: '@EndWokeness' },
  { id: 'WallStreetMav', label: '@WallStreetMav' },
  { id: 'MeghanMcCain', label: '@MeghanMcCain' },
  { id: 'TaraBull', label: '@TaraBull' },
  { id: 'GrageDustin', label: '@GrageDustin' },
  { id: 'Cernovich', label: '@Cernovich' },
  { id: 'TomFitton', label: '@TomFitton' },
  { id: 'Geiger_Capital', label: '@Geiger_Capital' },
  { id: 'BuzzPatterson', label: '@BuzzPatterson' },
  { id: 'Shawn_Farash', label: '@Shawn_Farash' },
  { id: 'NickAdamsinUSA', label: '@NickAdamsinUSA' },
  { id: 'VoteRandyFine', label: '@VoteRandyFine' },
  { id: 'BrilynHollyhand', label: '@BrilynHollyhand' },
];

export const INFLUENCER_X_HANDLES: string[] = INFLUENCER_X_ACCOUNTS.map(a => a.id);

// Drift guard: the influencer roster must stay in lock-step with the canonical
// social-account catalog's x-influencer lane. The catalog is the single source
// of truth (Task #1038); this file keeps the {id,label} avatar/name ownership
// but the HANDLE set is asserted against the catalog by
// scripts/social-account-catalog-drift.test.ts. See shared/socialAccountCatalog.ts.
