# Signing macOS builds

The electron-builder config supports hardened runtime signing and notarization.
To produce a signed, notarized DMG:

1. Install a Developer ID Application certificate in your login keychain.
2. Create an App Store Connect API key with the Developer role.
3. Store the notary credentials once:

   ```sh
   xcrun notarytool store-credentials aya-notarize \
     --key /path/to/AuthKey_XXXXXXXX.p8 \
     --key-id XXXXXXXX \
     --issuer 11111111-2222-3333-4444-555555555555
   ```

4. Build with the keychain profile:

   ```sh
   APPLE_KEYCHAIN=~/Library/Keychains/login.keychain-db \
   APPLE_KEYCHAIN_PROFILE=aya-notarize \
     npm run package
   ```

To force an unsigned local build:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package
```
