/**
 * The lines of the workspace charter templates from before the blocks (workspace/rules-text.ts renderCharter and renderRunJobHome
 * of every version until 2026-11-12, this PC's and the releases', also as the old fix pairs left them, and the few lines the
 * secretary wrote into charters itself), each as the first 12 hex digits of the sha1 of its key (charter-blocks.ts
 * charterLineKey: paths and the variable name as <S>, <W>, <ENV>). workspace-links reads it to move a charter without marks
 * into blocks (charter-blocks.ts); hashes, not the lines, so it stays small and holds no old wording to be read as a rule.
 * Made once by a tool from the old sources (not kept: the template no longer changes what these are).
 */
export const OLD_CHARTER_LINES = new Set<string>([ // legacy-name: charter-unmarked
  '015caa30fb08', '04546134a370', '045e36984adb', '058ac35446f1', '06d958bb530f', '074951fed218', '076ba968663c', '090586c83746',
  '0989c09ed4de', '09c74596b522', '09e013f2e60f', '0b50dc5ef897', '0ba680e38e83', '0ce65a91f9de', '0e97e4fd9f6f', '0ecc121e5384',
  '0ed54091efb9', '0f48db521e61', '0fc868227d6d', '105c13a8b6a7', '105c5eeb34e7', '10ebc84bedf4', '12cc79079c16', '1327c2f23b32',
  '143f8a6ff937', '154c2a404b4b', '1555dadee45c', '16964e30d5f0', '172d44d26edb', '19673da8761d', '19b38670f789', '1b1fee756137',
  '1b8529bb2acb', '1c2dead9e784', '1d4a0b47b35c', '1e41cfd7aef0', '21e7d662a92b', '2239c8f84bc1', '2268b35c6e08', '22e555f2e299',
  '23317a2eebdc', '23e2f072767f', '249bd24daac4', '266726ed4fea', '2741e9670692', '283f8aa051c1', '2c093cd5c06a', '2f54095acdad',
  '2fe9603e6dd8', '30a3cae35df7', '33955aba76e6', '36068d8c5484', '367a05c0bf0c', '387bf931ee58', '38b3327f5d1e', '39d4ca5b95d0',
  '3a975f046a6f', '3bafe6c0b0e9', '3c3349b1a9c4', '3c9889d8ad93', '3ca2d6b2a249', '3cc10f823885', '3d1c66e79596', '3f814d99ae9b',
  '3f8d866c5352', '3fbc0242ed7a', '40164cdbad24', '403f69a1a936', '406bd1c2c11e', '408bb9502356', '408fcd567f68', '4325c545eb23',
  '45e9ec63f47b', '460f4192b8aa', '465c3693fcea', '4790eb22ca4f', '48d033810df1', '492a511212b2', '4933c31c4e30', '4af3a959756c',
  '4b39debb1b46', '4c6576d5c3b8', '4ee078f66a01', '51f467982af1', '52028a46e211', '528282138ed2', '55bf96ecdcf5', '561c1e6dc673',
  '562856285f4b', '5753d0c2f001', '58984e42f86c', '598f9f61cbe8', '5a8e7581701e', '5b811f09e6db', '5c426ea5d183', '5f317516f53e',
  '5f88039a9065', '5ff5a2251993', '60fb4b5c0924', '62615b5fbb3d', '637191a90a17', '63f8f772e00d', '65c9e4b01f98', '65f3af1d32f0',
  '6613f2f62b12', '686a263ad716', '696bc45cc406', '6ac41a8da146', '6b8341313d65', '6c531c99a29e', '6de01685186b', '6f0bb955595e',
  '6f685d04bc39', '70053509cc95', '71b9abb354eb', '71d7b99b2978', '72608a48877c', '72b460cda303', '7f1328cea47b', '802cb095fa19',
  '803f793fcde3', '80aab93f8f21', '81bdb01b7a3e', '82c50ccd79e1', '853da8898418', '8932fdc2e249', '89413cb3e06c', '895bea29471a',
  '8a84c8c3efe8', '8badba6b3023', '8ea6521d331b', '8f42468d7e81', '8f6924e2fe19', '8fa803f25ef0', '9130159f63c7', '921003a168c5',
  '925bfc983149', '92ccc32a36bf', '92f82d2aad91', '94387c812092', '9462938fe2ad', '94661f7e32e4', '95b63da1706e', '969db93c1cb0',
  '9821c8e84a3a', '984b5cb1fc88', '9b5c42011415', '9bb304408313', '9c5aa842017c', '9d60ca8a36a2', 'a2eb67580021', 'a4ea558acb09',
  'a565b8758ebb', 'a623ec879f75', 'a64b80e699df', 'a6677a2e0441', 'a6a11bb59812', 'a743f5fa1b5c', 'a82a45172cbc', 'a8c922ded28d',
  'aa11bf79fe14', 'aa9da8d60cc9', 'ab8ac90cc808', 'abe79413fbc5', 'ae43ea97e11f', 'b067c618ccce', 'b13b166c4e33', 'b145aa7b6fd6',
  'b2f5e37a5ffa', 'b50e9d790ecd', 'b5f79225e844', 'b7352138c92a', 'b7a98c486fb5', 'b86dfcd771f2', 'b891cef71c38', 'b93596881b7d',
  'bb3885a588ee', 'bbc0aff80688', 'bbe649640bd0', 'bbef17a7a9f0', 'bd86a59e5fd8', 'bdfae8179586', 'be488ca854a2', 'bebe7f563a6d',
  'bed8d0a135b8', 'c13c9b4575c2', 'c2b7df6201fd', 'c3d848cf8496', 'c6b21d766fdf', 'c6ef44b82f3d', 'c7f855413b91', 'c80bad0e5a43',
  'c9b11adb2ccd', 'cea7714493ee', 'd129d8029a04', 'd2688a32c803', 'd56449410787', 'd56acead7f45', 'd82daae6054b', 'da85408a5f2f',
  'dad66dc24986', 'db5a4bb8ac37', 'dc105ce5447b', 'dc6ec1c39618', 'dd5d03a67319', 'deb0a2f66ac9', 'df0babeeebfc', 'df70cae4d8b4',
  'e03742b5c5ff', 'e12ae84152f0', 'e247d684b183', 'e2a65258c41d', 'e6820d2608e2', 'e95868ac8b6b', 'e9e072d5beb8', 'e9e177f51e05',
  'eb0b14443a2e', 'eb2c662df394', 'ed5ec4e7a459', 'ee291f6bcf05', 'ef5d7d9a8c20', 'f1b2ef302b14', 'f1f3c9d43195', 'f3eac03ad61f',
  'f3f5ff13a4df', 'f5e9424bf66f', 'f5ff501e749f', 'f659a844b289', 'f7ddc60b6e46', 'f859609c9db8', 'f9aa3a78dbf7', 'fa2f68cb6dbc',
  'fc4208a21287', 'fd4bc3370ac6', 'fec6ecfb2e96', 'ff7842e7f429',
]);
