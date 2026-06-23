# Repo Blueprint

## Workspace Strategy

BeautyGo uses one workspace with three app surfaces and one shared package:

1. `apps/super-app`
   Shared customer and artist application shell
2. `apps/admin-web`
   Operations and review dashboard
3. `apps/api`
   Backend domain and integration layer
4. `packages/domain-types`
   Shared business language from the PRD

## Domain Ownership

Planned backend module order:

1. auth and roles
2. artist onboarding
3. service package
4. availability
5. search and discovery
6. order
7. payment and settlement
8. review and dispute

## Why This Shape

1. keeps customer and artist flows in one mobile codebase
2. keeps admin concerns separate from booking flows
3. centralizes PRD vocabulary in shared types
4. lets us ship one vertical slice at a time without restructuring later

## Immediate Follow-Up

1. install workspace dependencies
2. run the API and both frontends locally
3. implement auth and role switch shell
4. add the first API slice for artist onboarding
