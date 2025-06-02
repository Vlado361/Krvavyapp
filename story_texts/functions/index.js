// Importuj potrebné Firebase moduly
const {onRequest} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const {getStorage} = require("firebase-admin/storage");
const logger = require("firebase-functions/logger");

// Inicializuj Firebase Admin SDK
initializeApp();

exports.syncTranscriptsToFirestore = onRequest(async (req, res) => {
  // Pridal som V2 do logu, aby sme videli, že beží nová verzia
  logger.info("Spúšťa sa synchronizácia prepisov - V3.", {structuredData: true});

  const folderPath = "transcripts/";
  const firestoreCollection = "transcripts";

  // *** KĽÚČOVÁ OPRAVA: Názov bucketu je teraz správne nastavený na .firebasestorage.app ***
  const explicitBucketName = "podcast-central-xl9zv.firebasestorage.app";

  // *** KĽÚČOVÁ OPRAVA: Skús rôzne spôsoby pripojenia k Firestore ***
  let db;
  
  try {
    // Skús základné pripojenie
    db = getFirestore();
    logger.info("Pokúšam sa pripojiť k Firestore s getFirestore()");
  } catch (error1) {
    logger.error("Chyba s getFirestore():", error1);
    try {
      // Skús s explicitným project ID
      db = getFirestore('podcast-central-xl9zv');
      logger.info("Pokúšam sa pripojiť k Firestore s project ID");
    } catch (error2) {
      logger.error("Chyba s project ID:", error2);
      res.status(500).send(`Nemožno sa pripojiť k Firestore: ${error1.message}`);
      return;
    }
  }
  
  // Test pripojenia k Firestore
  try {
    // Vytvor kolekciu ak neexistuje
    const testCollection = db.collection('transcripts');
    const testDoc = testCollection.doc('init-test');
    await testDoc.set({
      title: 'Initialization test',
      createdAt: new Date(),
      isTest: true
    });
    logger.info("Firestore pripojenie a kolekcia 'transcripts' vytvorená úspešne");
  } catch (firestoreTestError) {
    logger.error("Chyba pri teste Firestore:", firestoreTestError);
    res.status(500).send(`Chyba pri pripojení k Firestore databáze: ${firestoreTestError.message}`);
    return;
  }
  
  const bucket = getStorage().bucket(explicitBucketName);

  try {
    // Testovanie pripojenia k bucketu
    logger.info(`Testovanie: Načítavam všetky súbory z bucketu...`);
    const [allFiles] = await bucket.getFiles();
    logger.info(`Všetky súbory v buckete: ${allFiles.length}`);
    if (allFiles.length > 0) {
      logger.info(`Prvých 5 súborov: ${allFiles.slice(0, 5).map(f => f.name).join(', ')}`);
    }

    // 1. Načítaj zoznam súborov z Firebase Storage s prefix
    logger.info(`Pokúšam sa načítať súbory z bucketu: ${explicitBucketName}, priečinok: ${folderPath}`);
    const [files] = await bucket.getFiles({prefix: folderPath});

    // DEBUG: Vypíš všetky nájdené súbory
    logger.info(`Celkovo nájdených súborov s prefix '${folderPath}': ${files.length}`);
    if (files.length > 0) {
      logger.info(`Prvých 10 súborov: ${files.slice(0, 10).map(f => f.name).join(', ')}`);
    }

    if (files.length === 0) {
      logger.info(`V priečinku ${folderPath} neboli nájdené žiadne súbory.`);
      res.status(200).send(`V priečinku ${folderPath} neboli nájdené žiadne súbory.`);
      return;
    }

    let filesProcessedCount = 0;
    let filesSkippedCount = 0;

    for (const file of files) {
      // DEBUG: Vypíš info o každom súbore
      logger.info(`Kontrolujem súbor: "${file.name}"`);
      logger.info(`  - končí na .txt: ${file.name.toLowerCase().endsWith(".txt")}`);
      logger.info(`  - nie je priečinok: ${!file.name.endsWith("/")}`);
      
      // Uisti sa, že spracúvaš iba súbory a nie priečinky, a že sú to .txt súbory
      if (!file.name.endsWith("/") && file.name.toLowerCase().endsWith(".txt")) {
        const fullFilePath = file.name; // napr. "transcripts/moj_prepis.txt"
        const fileNameWithExtension = fullFilePath.substring(folderPath.length); // napr. "moj_prepis.txt"

        // Preskoč, ak je názov súboru prázdny
        if (!fileNameWithExtension) {
            logger.debug(`Preskočený prázdny názov súboru po odstránení cesty priečinka: ${fullFilePath}`);
            filesSkippedCount++;
            continue;
        }

        const title = fileNameWithExtension.substring(0, fileNameWithExtension.lastIndexOf("."));

        // Generovanie ID dokumentu
        let documentId = title.replace(/\s+/g, '_') // Nahradí medzery podčiarkovníkmi
                             .replace(/[^a-zA-Z0-9_.-]/g, ''); // Odstráni neplatné znaky

        // Ak je title príliš generický alebo skončí prázdny po úpravách, použijeme upravený názov súboru
        if (!documentId) {
            documentId = fileNameWithExtension.replace(/\.[^/.]+$/, "") // Odstráni príponu
                                             .replace(/\s+/g, '_')
                                             .replace(/[^a-zA-Z0-9_.-]/g, '');
            logger.warn(`Vygenerované ID dokumentu z názvu (title) bolo prázdne pre súbor: ${fileNameWithExtension}. Používam upravený názov súboru ako ID: "${documentId}"`);
        }

        // AK JE ID STÁLE PRÁZDNE, JE TO PROBLÉM!
        if (!documentId) {
            logger.error(`Kritická chyba: Nemohol som vygenerovať platné ID dokumentu pre súbor: ${fileNameWithExtension}. Preskakujem.`);
            filesSkippedCount++;
            continue;
        }

        // Limitácia dĺžky ID
        if (documentId.length > 500) {
            logger.warn(`ID dokumentu je príliš dlhé (${documentId.length} znakov) pre súbor: ${fileNameWithExtension}. Skracujem na 500 znakov.`);
            documentId = documentId.substring(0, 500);
        }

        // 2. Vygeneruj verejnú URL bez tokenov
        const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(file.name)}?alt=media`;

        logger.info(`Spracúva sa súbor: "${fileNameWithExtension}", Názov epizódy: "${title}", Generované ID dokumentu: "${documentId}", URL: "${publicUrl}"`);

        // 3. Ulož URL do Firestore
        const docRef = db.collection(firestoreCollection).doc(documentId);

        // Individuálne spracovanie chýb pre každý zápis
        try {
            await docRef.set({
                title: title,
                url: publicUrl,
                fileName: fileNameWithExtension,
                updatedAt: new Date()
            }, { merge: true });
            filesProcessedCount++;
            logger.info(`Úspešne uložený prepis pre súbor: "${fileNameWithExtension}", ID dokumentu: "${documentId}"`);
        } catch (firestoreError) {
            logger.error(`Chyba pri ukladaní prepisu pre súbor: "${fileNameWithExtension}", ID dokumentu: "${documentId}" do Firestore.`, firestoreError);
            filesSkippedCount++;
        }
      } else {
        logger.debug(`Preskočený súbor (nie je .txt alebo je priečinok): ${file.name}`);
        filesSkippedCount++;
      }
    }

    if (filesProcessedCount === 0 && filesSkippedCount === files.length) {
        const message = `V priečinku ${folderPath} neboli nájdené žiadne relevantné .txt súbory na spracovanie.`;
        logger.info(message);
        res.status(200).send(message);
        return;
    }

    const successMessage = `Synchronizácia dokončená. Úspešne spracovaných ${filesProcessedCount} prepisov. Preskočených/neúspešných: ${filesSkippedCount}.`;
    logger.info(successMessage);
    res.status(200).send(successMessage);

  } catch (error) {
    // Toto je pre neočakávané chyby
    logger.error("Kritická chyba pri spracovaní synchronizácie prepisov:", error);
    res.status(500).send(`Nastala chyba pri synchronizácii prepisov: ${error.message}`);
  }
});