# Branding and compatibility

## Public product name

- The user-visible product name is `Naina`.
- The npm package name is `naina`.
- New local and Compose installations default to `admin@naina.local` and `Naina Admin`.
- Migration `021-naina-brand.sql` changes the untouched default organization name from `Rental Radar` to `Naina` without overwriting a customer-customized organization name.

## Intentionally retained internal identifiers

The Compose project, named volumes and networks still use the `rental-radar-*` names. Runtime secret mounts under `/run/rendar`, the browser asset filename, CSS implementation classes, and the auth-expiry event key also retain their legacy names. These identifiers are not user-facing; changing them would orphan existing database/browser state or break runtime integration contracts.
