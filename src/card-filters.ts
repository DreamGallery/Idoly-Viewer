export type CardTraits = {
 attribute: 'vocal' | 'dance' | 'visual' | null;
 role: 'scorer' | 'buffer' | 'supporter' | null;
 hasSp: boolean;
 hasEvolution?: boolean;
};
export type CardFilters = {
 attribute: 'all' | NonNullable<CardTraits['attribute']>;
 role: 'all' | NonNullable<CardTraits['role']>;
 spOnly: boolean;
 evolutionOnly: boolean;
};
export const defaultCardFilters: CardFilters = {attribute:'all',role:'all',spOnly:false,evolutionOnly:false};
export const attributeOptions = [['all','全部花色'],['vocal','Vocal · 歌唱'],['dance','Dance · 舞蹈'],['visual','Visual · 形象']] as const;
export const roleOptions = [['all','全部方向'],['scorer','得分手'],['buffer','辅助'],['supporter','支援']] as const;
export function matchesCardFilters(traits: CardTraits | undefined, filters: CardFilters) {
 return (filters.attribute==='all'||traits?.attribute===filters.attribute)
  && (filters.role==='all'||traits?.role===filters.role)
  && (!filters.spOnly||traits?.hasSp===true)
  && (!filters.evolutionOnly||traits?.hasEvolution===true);
}
