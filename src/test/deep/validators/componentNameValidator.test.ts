import { describe, it, expect } from 'vitest';
import { validateComponentName, GENERIC_DIRS } from '../../../deep/validators/componentNameValidator';

describe('validateComponentName', () => {
  it('anchors LLM name for generic dir "src"', () => {
    const result = validateComponentName('src', 'Core Services');
    expect(result.validatedName).toBe('Core Services (src/)');
    expect(result.changed).toBe(true);
  });

  it('rejects LLM name for non-generic "risk-register"', () => {
    const result = validateComponentName('risk-register', 'Enterprise Risk Portal');
    expect(result.validatedName).toBe('risk-register');
    expect(result.changed).toBe(true);
  });

  it('rejects LLM name for non-generic "KustoFunctions"', () => {
    const result = validateComponentName('KustoFunctions', 'Analytical Query Library');
    expect(result.validatedName).toBe('KustoFunctions');
    expect(result.changed).toBe(true);
  });

  it('anchors LLM name for generic dir "common"', () => {
    const result = validateComponentName('common', 'Platform Libraries');
    expect(result.validatedName).toBe('Platform Libraries (common/)');
    expect(result.changed).toBe(true);
  });

  it('returns exact match unchanged for "detection"', () => {
    const result = validateComponentName('detection', 'detection');
    expect(result.validatedName).toBe('detection');
    expect(result.changed).toBe(false);
  });

  it('strips "Engine" suffix for generic dir', () => {
    const result = validateComponentName('lib', 'Data Processing Engine');
    expect(result.validatedName).toBe('Data Processing (lib/)');
    expect(result.changed).toBe(true);
  });

  it('strips "System" suffix for non-generic dir', () => {
    const result = validateComponentName('LogsGenerator', 'Traffic Simulation System');
    expect(result.validatedName).toBe('LogsGenerator');
    expect(result.changed).toBe(true);
  });

  it('handles nested paths correctly', () => {
    const result = validateComponentName('misc/experiments/LogsGenerator', 'Traffic Simulation Engine');
    expect(result.validatedName).toBe('LogsGenerator');
    expect(result.changed).toBe(true);
  });

  it('keeps LLM name that already includes dir name', () => {
    const result = validateComponentName('utils', 'Core Utils Library');
    // "utils" is generic, and "Core Utils Library" already contains "utils" (case-insensitive)
    expect(result.validatedName.toLowerCase()).toContain('utils');
  });

  it('truncates overly long LLM names for generic dirs', () => {
    const longName = 'A'.repeat(60) + ' Service';
    const result = validateComponentName('src', longName);
    expect(result.validatedName.length).toBeLessThanOrEqual(60);
    expect(result.validatedName).toContain('src/');
  });

  it('handles short dir names (<=3 chars) as generic', () => {
    const result = validateComponentName('api', 'REST API Gateway');
    // "api" is <=3 chars so treated as generic; "Gateway" stripped; "API" already contains "api"
    expect(result.validatedName.toLowerCase()).toContain('api');
    expect(result.changed).toBe(true);
  });

  it('GENERIC_DIRS set includes expected entries', () => {
    expect(GENERIC_DIRS.has('src')).toBe(true);
    expect(GENERIC_DIRS.has('common')).toBe(true);
    expect(GENERIC_DIRS.has('utils')).toBe(true);
    expect(GENERIC_DIRS.has('app')).toBe(true);
    expect(GENERIC_DIRS.has('packages')).toBe(true);
    expect(GENERIC_DIRS.has('core')).toBe(true);
    expect(GENERIC_DIRS.has('shared')).toBe(true);
  });
});
