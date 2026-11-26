#include <esp_now.h>
#include <WiFi.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// =================================================================
// NITRO - CODE MANETTE (version d'Aymen) + LIEN USB AVEC LE SITE
// Tout le code d'Aymen est gardé (adresse MAC, calibration, zone
// morte, affichage LCD en %). En plus :
//  1) la manette écrit sur l'USB ce qu'elle envoie à la voiture :
//       N,angle,vitesse,source      (source : M = joysticks, W = site)
//     -> le site affiche ANGLE / VITESSE / SOURCE et fait bouger la
//        voiture 3D pareil (mode Miroir)
//  2) elle lit les ordres du site sur l'USB :
//       W,angle,vitesse
//     -> elle les transmet à la voiture (mode Pilote)
// Règles de sécurité :
//  - les vrais joysticks sont TOUJOURS prioritaires sur le site
//  - si le site n'envoie plus rien pendant 0,3 s -> on l'ignore
//  - STOP VOCAL : le site envoie "X" -> arrêt immédiat (90 / 0).
//    On repart après avoir relâché les joysticks.
// IMPORTANT : fermer le Moniteur série d'Arduino IDE avant de
// connecter le site (sinon le port USB est déjà occupé).
// =================================================================

// =================================================================
// 1. ADRESSE MAC DE LA VOITURE (30:76:F5:93:49:24)
// =================================================================
uint8_t adresseMacVoiture[] = {0x30, 0x76, 0xF5, 0x93, 0x49, 0x24};


// =================================================================
// 2. CONFIGURATION DE L'ÉCRAN LCD ET DES BROCHES
// =================================================================
LiquidCrystal_I2C lcd(0x27, 16, 2);

const int pinJoystickDirection = 34; // Joystick Gauche (Axe X - Direction)
const int pinJoystickGaz = 33;       // Joystick Droite (Axe Y - Gaz)

// Centres réels mesurés automatiquement au démarrage
int centreDirection = 1900;
int centreGaz = 1900;

// Zone morte élargie pour supprimer le drift au repos
const int zoneMorte = 350;

// Variables de lecture et de calcul
int valeurBruteDirection = 0;
int valeurBruteGaz = 0;
int pourcentageAffichageGaz = 0;


// =================================================================
// 3. STRUCTURE DES DONNÉES ENVOYÉES À LA VOITURE (ne pas changer)
// =================================================================
typedef struct struct_message {
  int angleServo;   // Valeur entre 45° (Gauche) et 135° (Droite)
  int vitessePWM;   // Valeur entre -255 (Arrière max) et +255 (Avant max)
} struct_message;

struct_message donneesEnvoyees;
esp_now_peer_info_t infosVoiture;


// =================================================================
// 4. ORDRES REÇUS DU SITE PAR USB
// =================================================================
int angleWeb = 90;
int vitesseWeb = 0;
unsigned long dernierOrdreWeb = 0;
const unsigned long delaiWeb = 300;   // 0,3 s sans ordre -> on ignore le site
bool arretVocal = false;              // "X" reçu du site (stop vocal)
unsigned long arretDepuis = 0;
char ligneUSB[32];
int posLigne = 0;

void lireOrdresSite() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      ligneUSB[posLigne] = 0;
      if (posLigne == 1 && ligneUSB[0] == 'X') {   // STOP VOCAL
        arretVocal = true;
        arretDepuis = millis();
        dernierOrdreWeb = 0;
      }
      int a, v;
      if (posLigne > 0 && sscanf(ligneUSB, "W,%d,%d", &a, &v) == 2) {
        angleWeb = constrain(a, 45, 135);
        vitesseWeb = constrain(v, -255, 255);
        dernierOrdreWeb = millis();
      }
      posLigne = 0;
    } else if (posLigne < (int)sizeof(ligneUSB) - 1) {
      ligneUSB[posLigne++] = c;
    } else {
      posLigne = 0;  // ligne trop longue : on la jette
    }
  }
}


void setup() {
  Serial.begin(115200);

  // Configuration des entrées analogiques des joysticks
  pinMode(pinJoystickDirection, INPUT);
  pinMode(pinJoystickGaz, INPUT);

  // Initialisation de l'écran LCD (SDA = Pin 21, SCL = Pin 22)
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("CALIBRATION...");

  // -----------------------------------------------------------------
  // AUTO-CALIBRATION DU POINT MILIEU DES DEUX JOYSTICKS (Anti-Drift)
  // -----------------------------------------------------------------
  long sommeDirection = 0;
  long sommeGaz = 0;

  for (int i = 0; i < 20; i = i + 1) {
    sommeDirection = sommeDirection + analogRead(pinJoystickDirection);
    sommeGaz = sommeGaz + analogRead(pinJoystickGaz);
    delay(20);
  }

  centreDirection = sommeDirection / 20;
  centreGaz = sommeGaz / 20;

  Serial.print("Centre Direction calibre a : ");
  Serial.println(centreDirection);
  Serial.print("Centre Gaz calibre a : ");
  Serial.println(centreGaz);

  // Affichage des titres sur l'écran LCD
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("DIR    | GAZ    ");

  // Passage du Wi-Fi en mode Station
  WiFi.mode(WIFI_STA);

  // Initialisation du protocole ESP-NOW
  // (en cas d'erreur, on n'arrête PAS le programme : le lien USB avec
  //  le site doit continuer à marcher, même sans voiture)
  if (esp_now_init() != ESP_OK) {
    Serial.println("Erreur lors de l'initialisation d'ESP-NOW");
  } else {
    memcpy(infosVoiture.peer_addr, adresseMacVoiture, 6);
    infosVoiture.channel = 0;
    infosVoiture.encrypt = false;
    if (esp_now_add_peer(&infosVoiture) != ESP_OK) {
      Serial.println("Impossible d'ajouter la voiture en destinataire");
    }
  }
  Serial.println("NITRO manette prete (lien USB actif)");
}


void loop() {
  // -----------------------------------------------------------------
  // 1. LECTURE DES DEUX JOYSTICKS (0 à 4095)
  // -----------------------------------------------------------------
  valeurBruteDirection = analogRead(pinJoystickDirection);
  valeurBruteGaz = analogRead(pinJoystickGaz);

  int angleJoy = 90;
  int vitesseJoy = 0;
  int pourcentJoy = 0;

  // -----------------------------------------------------------------
  // 2. CALCUL DE LA DIRECTION (identique au code d'Aymen)
  // -----------------------------------------------------------------
  if (valeurBruteDirection < (centreDirection - zoneMorte)) {
    angleJoy = map(valeurBruteDirection, 0, centreDirection - zoneMorte, 45, 90);
    angleJoy = constrain(angleJoy, 45, 90);
  }
  else if (valeurBruteDirection > (centreDirection + zoneMorte)) {
    angleJoy = map(valeurBruteDirection, centreDirection + zoneMorte, 4095, 90, 135);
    angleJoy = constrain(angleJoy, 90, 135);
  }

  // -----------------------------------------------------------------
  // 3. CALCUL DES GAZ AVANT / ARRIÈRE (identique au code d'Aymen)
  // -----------------------------------------------------------------
  if (valeurBruteGaz < (centreGaz - zoneMorte)) {
    vitesseJoy = map(valeurBruteGaz, 0, centreGaz - zoneMorte, -255, -70);
    vitesseJoy = constrain(vitesseJoy, -255, 0);
    pourcentJoy = map(valeurBruteGaz, 0, centreGaz - zoneMorte, -100, -1);
    pourcentJoy = constrain(pourcentJoy, -100, 0);
  }
  else if (valeurBruteGaz > (centreGaz + zoneMorte)) {
    vitesseJoy = map(valeurBruteGaz, centreGaz + zoneMorte, 4095, 70, 255);
    vitesseJoy = constrain(vitesseJoy, 0, 255);
    pourcentJoy = map(valeurBruteGaz, centreGaz + zoneMorte, 4095, 1, 100);
    pourcentJoy = constrain(pourcentJoy, 0, 100);
  }

  // -----------------------------------------------------------------
  // 4. QUI CONDUIT ? stop vocal > joysticks > site (s'il parle encore)
  // -----------------------------------------------------------------
  lireOrdresSite();
  bool joystickTouche = (angleJoy != 90) || (vitesseJoy != 0);
  bool siteActif = (dernierOrdreWeb != 0) && (millis() - dernierOrdreWeb < delaiWeb);
  char source = 'M';

  // le stop vocal dure jusqu'à ce qu'on relâche les joysticks (0,8 s minimum)
  if (arretVocal && !joystickTouche && millis() - arretDepuis > 800) {
    arretVocal = false;
  }

  if (arretVocal) {
    donneesEnvoyees.angleServo = 90;
    donneesEnvoyees.vitessePWM = 0;
    pourcentageAffichageGaz = 0;
    source = 'V';
  } else if (!joystickTouche && siteActif) {
    donneesEnvoyees.angleServo = angleWeb;
    donneesEnvoyees.vitessePWM = vitesseWeb;
    pourcentageAffichageGaz = (vitesseWeb * 100) / 255;
    source = 'W';
  } else {
    donneesEnvoyees.angleServo = angleJoy;
    donneesEnvoyees.vitessePWM = vitesseJoy;
    pourcentageAffichageGaz = pourcentJoy;
  }

  // -----------------------------------------------------------------
  // 5. ENVOI SANS FIL À LA VOITURE VIA ESP-NOW
  // -----------------------------------------------------------------
  esp_now_send(adresseMacVoiture, (uint8_t *) &donneesEnvoyees, sizeof(donneesEnvoyees));

  // -----------------------------------------------------------------
  // 6. ENVOI AU SITE PAR USB : N,angle,vitesse,source
  //    (c'est cette ligne qui fait apparaître les chiffres sur le site)
  // -----------------------------------------------------------------
  Serial.print("N,");
  Serial.print(donneesEnvoyees.angleServo);
  Serial.print(",");
  Serial.print(donneesEnvoyees.vitessePWM);
  Serial.print(",");
  Serial.println(source);

  // -----------------------------------------------------------------
  // 7. ÉCRAN LCD (identique au code d'Aymen, + W/S en haut à droite)
  // -----------------------------------------------------------------
  lcd.setCursor(15, 0);
  lcd.print(source == 'W' ? "W" : (source == 'V' ? "S" : " "));   // W = le site conduit, S = stop vocal

  lcd.setCursor(0, 1);
  if (donneesEnvoyees.angleServo < 88) {
    lcd.print("G:");
    lcd.print(donneesEnvoyees.angleServo);
    lcd.print("   ");
  }
  else if (donneesEnvoyees.angleServo > 92) {
    lcd.print("D:");
    lcd.print(donneesEnvoyees.angleServo);
    lcd.print("   ");
  }
  else {
    lcd.print("CENTRE ");
  }

  lcd.setCursor(7, 1);
  lcd.print("| ");

  lcd.setCursor(9, 1);
  if (pourcentageAffichageGaz > 0) {
    lcd.print("+");
    lcd.print(pourcentageAffichageGaz);
    lcd.print("%   ");
  }
  else if (pourcentageAffichageGaz < 0) {
    lcd.print(pourcentageAffichageGaz);
    lcd.print("%   ");
  }
  else {
    lcd.print("STOP   ");
  }

  // Envoi des commandes 20 fois par seconde
  delay(50);
}
