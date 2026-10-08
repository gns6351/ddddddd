// 실제 시나리오 초안(content/scenarios) 구조 검증: 스키마·3턴·fact_ids·3턴 자동적 사고, 미확정 표시는 version만
const { createScenarioRegistry } = require('../../core/scenarioRegistry');
const { loadConfig } = require('../../core/config');
const { countPlaceholders } = require('../../core/util');

describe('content/scenarios 초안', () => {
  const cfg = loadConfig();
  const reg = createScenarioRegistry(cfg.contentDir, cfg.experiment.scenarios);
  it('구조 오류 0, 이미지 미사용, 검토 전 version 표시로 게이트 차단 유지', () => {
    expect(reg.report.map((r) => r.errors)).toEqual([[], [], []]);
    for (const id of reg.ids()) {
      const s = reg.get(id);
      expect(s.image).toBeUndefined();
      expect(reg.publicView(id).image_url).toBeNull();
      expect(countPlaceholders({ ...s, version: '' })).toBe(0);
      expect(s.version).toMatch(/^\[미확정:B01\]/);
      expect(s.facts.length).toBeGreaterThanOrEqual(5);
      expect(s.facts.length).toBeLessThanOrEqual(7);
    }
  });
});
