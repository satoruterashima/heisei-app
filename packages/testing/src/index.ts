export function createMockProfile(overrides = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    username: 'test_user',
    displayName: 'テストユーザー',
    isAgeVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
