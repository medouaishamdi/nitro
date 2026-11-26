#include <esp_now.h>
#include <WiFi.h>
#include <ESP32Servo.h>

// =================================================================
// NITRO - CODE VOITURE (version d'Aymen, module L298N) - corrigé
// Ce qui change par rapport à la version d'Aymen :
//  1) Au démarrage, la voiture affiche SON adresse MAC dans le
//     Moniteur série : c'est elle qu'il faut mettre dans la manette.
//  2) Le PWM du moteur (ENA) a son propre canal (6) avec ledc,
//     séparé du timer du servomoteur : analogWrite() et ESP32Servo
//     peuvent sinon se voler le même timer (moteur qui ne tourne pas).
//  3) La réception ESP-NOW ne fait que copier les données ; le
//     servo et le moteur sont commandés dans loop() (plus fiable que
//     de les piloter dans la fonction de réception Wi-Fi).
//  4) Le Moniteur série dit si des messages arrivent ou non.
// Cablage inchangé : servo 18, ENA 27, IN1 25, IN2 26.
// =================================================================

// =================================================================
// 1. BROCHES ET RÉGLAGE DU CENTRE DU SERVOMOTEUR
// =================================================================
const int pinServo = 18; // Fil signal du servomoteur de direction

const int pinENA = 27;   // Broche ENA du L298N (Vitesse PWM)
const int pinIN1 = 25;   // Broche IN1 du L298N (Sens)
const int pinIN2 = 26;   // Broche IN2 du L298N (Sens)

// PWM du moteur : canal réservé (6), 1 kHz, 8 bits (0 à 255)
const int CANAL_ENA = 6;
const int FREQ_ENA  = 1000;
const int RES_ENA   = 8;

// RÉGLAGE DU NEUTRE (TRIM) :
// Si les roues tirent à gauche à 90°, augmente cette valeur (ex: 95, 100 ou 105)
const int angleNeutre = 90;

Servo servoDirection;


// =================================================================
// 2. STRUCTURE DES DONNÉES REÇUES (Identique à la manette)
// =================================================================
typedef struct struct_message {
  int angleServo;   // De 45° à 135°
  int vitessePWM;   // De -255 à +255
} struct_message;

volatile struct_message donneesRecues;
volatile unsigned long dernierMessageRecu = 0;
volatile unsigned long nbMessages = 0;

// Sécurité en cas de coupure de la manette
const unsigned long delaiSecurite = 500;

// Timer pour l'affichage dans le Moniteur Série
unsigned long dernierAffichageSerie = 0;


// =================================================================
// 3. PILOTAGE DU MODULE L298N
// =================================================================
void piloterMoteurL298N(int vitesse) {
  vitesse = constrain(vitesse, -255, 255);
  if (vitesse > 0) {
    // MARCHE AVANT : IN1 HIGH, IN2 LOW, vitesse sur ENA
    digitalWrite(pinIN1, HIGH);
    digitalWrite(pinIN2, LOW);
    ledcWrite(pinENA, vitesse);
  }
  else if (vitesse < 0) {
    // MARCHE ARRIÈRE : IN1 LOW, IN2 HIGH, vitesse positive sur ENA
    digitalWrite(pinIN1, LOW);
    digitalWrite(pinIN2, HIGH);
    ledcWrite(pinENA, -vitesse);
  }
  else {
    // ARRÊT
    digitalWrite(pinIN1, LOW);
    digitalWrite(pinIN2, LOW);
    ledcWrite(pinENA, 0);
  }
}


// =================================================================
// 4. RÉCEPTION ESP-NOW : on copie seulement les données
// =================================================================
void OnDataRecv(const esp_now_recv_info *info, const uint8_t *incomingData, int len) {
  if (len != sizeof(struct_message)) return;   // message inattendu : ignoré
  struct_message m;
  memcpy(&m, incomingData, sizeof(m));
  donneesRecues.angleServo = m.angleServo;
  donneesRecues.vitessePWM = m.vitessePWM;
  dernierMessageRecu = millis();
  nbMessages++;
}


void setup() {
  Serial.begin(115200);
  delay(300);

  // PWM du moteur sur son canal réservé (Arduino-ESP32 version 3.x)
  ledcAttachChannel(pinENA, FREQ_ENA, RES_ENA, CANAL_ENA);
  ledcWrite(pinENA, 0);
  pinMode(pinIN1, OUTPUT);
  pinMode(pinIN2, OUTPUT);
  piloterMoteurL298N(0);

  // Servomoteur sur le timer 0
  ESP32PWM::allocateTimer(0);
  servoDirection.setPeriodHertz(50);
  servoDirection.write(angleNeutre);     // neutre AVANT d'attacher (évite le coup à gauche)
  servoDirection.attach(pinServo, 500, 2400);

  donneesRecues.angleServo = 90;
  donneesRecues.vitessePWM = 0;

  // Wi-Fi en mode Station, sans mise en veille
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  delay(100);

  // ADRESSE MAC DE CETTE VOITURE : à recopier dans la manette
  Serial.print("ADRESSE MAC DE LA VOITURE : ");
  Serial.println(WiFi.macAddress());

  if (esp_now_init() != ESP_OK) {
    Serial.println("Erreur d'initialisation ESP-NOW");
    return;
  }
  esp_now_register_recv_cb(OnDataRecv);
  Serial.println("Voiture prete : en attente de la manette...");
}


void loop() {
  unsigned long maintenant = millis();
  bool liaisonOk = (dernierMessageRecu != 0) && (maintenant - dernierMessageRecu <= delaiSecurite);

  int angle = 90;
  int vitesse = 0;
  if (liaisonOk) {
    angle = donneesRecues.angleServo;
    vitesse = donneesRecues.vitessePWM;
  }

  // Direction avec le trim autour du neutre
  int angleCorrige = constrain(angleNeutre + (angle - 90), 40, 140);
  servoDirection.write(angleCorrige);

  // Moteur (arrêt automatique si plus de message depuis 0,5 s)
  piloterMoteurL298N(vitesse);

  // Diagnostic toutes les 200 ms dans le Moniteur série
  if (maintenant - dernierAffichageSerie >= 200) {
    dernierAffichageSerie = maintenant;
    if (!liaisonOk) {
      Serial.print("AUCUN MESSAGE DE LA MANETTE (recus au total : ");
      Serial.print(nbMessages);
      Serial.println(") -> verifier l'adresse MAC dans la manette");
    } else {
      Serial.print("Angle manette : ");
      Serial.print(angle);
      Serial.print(" deg | Servo : ");
      Serial.print(angleCorrige);
      Serial.print(" deg | Gaz PWM : ");
      Serial.println(vitesse);
    }
  }

  delay(5);
}
